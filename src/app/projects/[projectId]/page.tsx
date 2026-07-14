'use client';

import {
  use,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent
} from 'react';

import {
  createWaitingUploadStatus,
  type UploadStatus
} from '@/features/media/upload-ui-state';
import type {EvidenceItem} from '@/features/evidence/schemas';
import {processingConsentDataCategories} from '@/features/consent/processing-disclosure';
import {durationSecondsToMs} from '@/features/media/audio-duration';
import type {Question, Storyboard} from '@/features/story/story-service';
import {
  displayEvidenceClaim,
  buildStoryboardOptions,
  mergeStoryboardResponse,
  rebaseStoryboardConflict,
  shouldClearRequestDirty,
  serializeSceneEdit,
  type StoryboardAssetOptionSource
} from '@/features/story/storyboard-editor-state';

type ImageDraft = {
  file: File;
  previewUrl: string;
  caption: string;
  capturedAtText: string;
  knownPeople: string;
  progress: number;
  status: 'waiting' | 'uploading' | 'ready' | 'failed';
  reservationId?: string;
};

type ProviderRunSummary = {id: string; operation: string; provider: string; status: string; cacheHitCount: number; requestCount: number; estimatedCostMicros: number; settledCostMicros: number | null};

const putWithProgress = (
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (progress: number) => void
) =>
  new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', contentType);
    request.setRequestHeader('x-goog-if-generation-match', '0');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error('UPLOAD_FAILED'));
    request.onerror = () => reject(new Error('UPLOAD_FAILED'));
    request.send(body);
  });

export default function ProjectPage({
  params
}: {
  params: Promise<{projectId: string}>;
}) {
  const {projectId} = use(params);
  const [images, setImages] = useState<ImageDraft[]>([]);
  const [supportingText, setSupportingText] = useState('');
  const [sourceAudio, setSourceAudio] = useState<File | null>(null);
  const [textStatus, setTextStatus] = useState<UploadStatus>(
    createWaitingUploadStatus
  );
  const [audioStatus, setAudioStatus] = useState<UploadStatus>(
    createWaitingUploadStatus
  );
  const [message, setMessage] = useState('Add at least three photographs.');
  const [storagePermission, setStoragePermission] = useState(false);
  const [processingPermission, setProcessingPermission] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [availableAssets, setAvailableAssets] = useState<StoryboardAssetOptionSource[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [providerRuns, setProviderRuns] = useState<ProviderRunSummary[]>([]);
  const storyboardRef = useRef<Storyboard | null>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const draggedSceneId = useRef<string | null>(null);
  const dirtySceneIds = useRef(new Set<string>());
  const sceneEditGenerations = useRef(new Map<string, number>());
  const orderGeneration = useRef(0);
  const orderDirty = useRef(false);
  const previewUrls = useRef<string[]>([]);

  useEffect(
    () => () => {
      previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    []
  );
  useEffect(() => { storyboardRef.current = storyboard; }, [storyboard]);
  useEffect(() => {
    void fetch(`/api/projects/${projectId}/provider-runs`).then(async (response) => {
      if (response.ok) setProviderRuns(await response.json());
    }).catch(() => undefined);
  }, [projectId]);

  const chooseImages = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []).slice(0, 7);
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = selected.map((file) => URL.createObjectURL(file));
    setImages(
      selected.map((file, index) => ({
        file,
        previewUrl: previewUrls.current[index],
        caption: '',
        capturedAtText: '',
        knownPeople: '',
        progress: 0,
        status: 'waiting'
      }))
    );
  };

  const updateImage = (index: number, change: Partial<ImageDraft>) => {
    setImages((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? {...draft, ...change} : draft
      )
    );
  };

  const upload = async (
    body: Blob,
    file: {
      kind: 'image' | 'text' | 'source_audio';
      name: string;
      contentType: string;
      size: number;
      caption?: string;
      capturedAtText?: string;
      knownPeople?: string[];
      reservationId?: string;
      durationMs?: number;
    },
    onProgress: (progress: number) => void,
    onReservation: (assetId: string) => void
  ) => {
    if (file.reservationId) {
      const priorCompletion = await fetch(
        `/api/projects/${projectId}/assets/upload-url`,
        {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({assetId: file.reservationId})
        }
      );
      if (priorCompletion.ok) return;
    }
    const response = await fetch(
      `/api/projects/${projectId}/assets/upload-url`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(file)
      }
    );
    if (!response.ok) throw new Error('UPLOAD_FAILED');
    const signed = (await response.json()) as {assetId: string; uploadUrl: string};
    onReservation(signed.assetId);
    await putWithProgress(signed.uploadUrl, body, file.contentType, onProgress);
    const completed = await fetch(
      `/api/projects/${projectId}/assets/upload-url`,
      {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({assetId: signed.assetId})
      }
    );
    if (!completed.ok) throw new Error('UPLOAD_FAILED');
  };

  const readAudioDurationMs = (file: File) => new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const release = () => { URL.revokeObjectURL(url); audio.removeAttribute('src'); };
    audio.onloadedmetadata = () => {
      try { const duration = durationSecondsToMs(audio.duration); release(); resolve(duration); }
      catch (error) { release(); reject(error); }
    };
    audio.onerror = () => { release(); reject(new Error('AUDIO_DURATION_INVALID')); };
    audio.src = url;
  });

  const gather = async (event: FormEvent) => {
    event.preventDefault();
    if (images.length < 3) {
      setMessage('Choose at least three photographs before continuing.');
      return;
    }
    setMessage('Preserving your pieces…');
    let activeExtra: 'text' | 'audio' | null = null;
    try {
      for (const [index, draft] of images.entries()) {
        updateImage(index, {status: 'uploading'});
        try {
          await upload(
            draft.file,
            {
              kind: 'image',
              name: draft.file.name,
              contentType: draft.file.type,
              size: draft.file.size,
              reservationId: draft.reservationId,
              caption: draft.caption,
              capturedAtText: draft.capturedAtText,
              knownPeople: draft.knownPeople
                .split(',')
                .map((person) => person.trim())
                .filter(Boolean)
            },
            (progress) => updateImage(index, {progress}),
            (reservationId) => updateImage(index, {reservationId})
          );
          updateImage(index, {status: 'ready', progress: 100});
        } catch (error) {
          updateImage(index, {status: 'failed'});
          throw error;
        }
      }

      if (supportingText.trim()) {
        activeExtra = 'text';
        setTextStatus((current) => ({...current, status: 'uploading'}));
        const text = new Blob([supportingText], {type: 'text/plain'});
        await upload(
          text,
          {
            kind: 'text',
            name: 'supporting-text.txt',
            contentType: 'text/plain',
            size: text.size,
            reservationId: textStatus.reservationId
          },
          (progress) =>
            setTextStatus((current) => ({...current, progress})),
          (reservationId) =>
            setTextStatus((current) => ({...current, reservationId}))
        );
        setTextStatus((current) => ({...current, progress: 100, status: 'ready'}));
        activeExtra = null;
      }
      if (sourceAudio) {
        activeExtra = 'audio';
        setAudioStatus((current) => ({...current, status: 'uploading'}));
        const durationMs = await readAudioDurationMs(sourceAudio);
        await upload(
          sourceAudio,
          {
            kind: 'source_audio',
            name: sourceAudio.name,
            contentType: sourceAudio.type,
            size: sourceAudio.size,
            durationMs,
            reservationId: audioStatus.reservationId
          },
          (progress) =>
            setAudioStatus((current) => ({...current, progress})),
          (reservationId) =>
            setAudioStatus((current) => ({...current, reservationId}))
        );
        setAudioStatus((current) => ({...current, progress: 100, status: 'ready'}));
        activeExtra = null;
      }
      setMessage('Your family pieces are safely gathered.');
    } catch {
      if (activeExtra === 'text') {
        setTextStatus((current) => ({...current, status: 'failed'}));
      }
      if (activeExtra === 'audio') {
        setAudioStatus((current) => ({...current, status: 'failed'}));
      }
      setMessage('One piece could not be preserved. Please try again.');
    }
  };

  const loadEvidence = async () => {
    const [evidenceResponse, assetsResponse] = await Promise.all([
      fetch(`/api/projects/${projectId}/evidence`),
      fetch(`/api/projects/${projectId}/assets/upload-url`)
    ]);
    if (!evidenceResponse.ok || !assetsResponse.ok) return setMessage('The record could not be opened.');
    setEvidence(await evidenceResponse.json());
    setAvailableAssets(await assetsResponse.json());
    setMessage('Review each proposed detail before it can shape the film.');
  };

  const findStory = async () => {
    const response = await fetch(`/api/projects/${projectId}/analyze`, {method: 'POST'});
    setMessage(response.ok ? 'We are finding the story in your pieces. Return to review the record when it is ready.' : 'The story could not be prepared yet.');
  };

  const reviewEvidence = async (item: EvidenceItem, action: 'confirm' | 'correct' | 'reject') => {
    const response = await fetch(`/api/projects/${projectId}/evidence`, {
      method: 'PATCH', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action, evidenceId: item.id, ...(action === 'correct' ? {correction: corrections[item.id]} : {})})
    });
    if (!response.ok) return setMessage('That record change could not be saved.');
    const saved = await response.json() as EvidenceItem;
    setEvidence((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
    setMessage('Record saved.');
  };

  const generateQuestions = async () => {
    const response = await fetch(`/api/projects/${projectId}/questions`, {method: 'POST'});
    if (!response.ok) return setMessage('The questions could not be prepared yet.');
    setQuestions(await response.json());
    setMessage('Your questions are ready.');
  };

  const composeStoryboard = async () => {
    const response = await fetch(`/api/projects/${projectId}/storyboard`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: 'compose'})
    });
    if (!response.ok) return setMessage('Confirm at least one detail before shaping the film.');
    dirtySceneIds.current.clear();
    sceneEditGenerations.current.clear();
    orderDirty.current = false;
    orderGeneration.current = 0;
    setStoryboard(await response.json());
    setMessage('Your film outline is ready to review.');
  };

  const saveAnswer = async (questionId: string) => {
    const response = await fetch(`/api/projects/${projectId}/questions`, {
      method: 'PATCH', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({questionId, answer: answers[questionId]})
    });
    setMessage(response.ok ? 'Memory saved to the record.' : 'That memory could not be saved.');
  };

  const saveScene = async (sceneId: string) => {
    if (!storyboard) return;
    const scene = storyboard.scenes.find((entry) => entry.id === sceneId);
    if (!scene) return;
    const capturedGeneration = sceneEditGenerations.current.get(sceneId) ?? 0;
    const change = serializeSceneEdit(scene);
    const response = await fetch(`/api/projects/${projectId}/storyboard`, {
      method: 'PATCH', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'edit_scene', storyboardId: storyboard.id, sceneId, change, expectedRevision: storyboard.revision})
    });
    if (response.status === 409) return recoverStoryboardConflict();
    if (!response.ok) return setMessage('That scene could not be saved.');
    const incoming = await response.json() as Storyboard;
    if (shouldClearRequestDirty(capturedGeneration, sceneEditGenerations.current.get(sceneId) ?? 0)) dirtySceneIds.current.delete(sceneId);
    setStoryboard((current) => current ? mergeStoryboardResponse(current, incoming, {dirtySceneIds: dirtySceneIds.current, preserveLocalOrder: orderDirty.current}) : incoming);
    setMessage('Scene saved.');
  };

  const regenerateScene = async (sceneId: string) => {
    if (!storyboard) return;
    const capturedGeneration = sceneEditGenerations.current.get(sceneId) ?? 0;
    const response = await fetch(`/api/projects/${projectId}/storyboard`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'regenerate_scene', storyboardId: storyboard.id, sceneId, expectedRevision: storyboard.revision})
    });
    if (response.status === 409) return recoverStoryboardConflict();
    if (!response.ok) return setMessage('That scene could not be reshaped.');
    const incoming = await response.json() as Storyboard;
    if (shouldClearRequestDirty(capturedGeneration, sceneEditGenerations.current.get(sceneId) ?? 0)) dirtySceneIds.current.delete(sceneId);
    setStoryboard((current) => current ? mergeStoryboardResponse(current, incoming, {dirtySceneIds: dirtySceneIds.current, preserveLocalOrder: orderDirty.current}) : incoming);
    setMessage('Only the selected scene was reshaped.');
  };

  const saveOrder = async () => {
    if (!storyboard) return;
    const capturedOrderGeneration = orderGeneration.current;
    const response = await fetch(`/api/projects/${projectId}/storyboard`, {
      method: 'PATCH', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'reorder_scenes', storyboardId: storyboard.id, orderedSceneIds: storyboard.scenes.map((scene) => scene.id), expectedRevision: storyboard.revision})
    });
    if (response.status === 409) return recoverStoryboardConflict();
    if (!response.ok) return setMessage('The scene order could not be saved.');
    const incoming = await response.json() as Storyboard;
    if (shouldClearRequestDirty(capturedOrderGeneration, orderGeneration.current)) orderDirty.current = false;
    setStoryboard((current) => current ? mergeStoryboardResponse(current, incoming, {dirtySceneIds: dirtySceneIds.current, preserveLocalOrder: orderDirty.current}) : incoming);
    setMessage('Scene order saved.');
  };

  const updateSceneDraft = (sceneId: string, change: Partial<Storyboard['scenes'][number]>) => {
    dirtySceneIds.current.add(sceneId);
    sceneEditGenerations.current.set(sceneId, (sceneEditGenerations.current.get(sceneId) ?? 0) + 1);
    setStoryboard((current) => {
      const next = current && ({...current, scenes: current.scenes.map((scene) => scene.id === sceneId ? {...scene, ...change} : scene)});
      storyboardRef.current = next;
      return next;
    });
  };

  const recoverStoryboardConflict = async () => {
    if (!storyboardRef.current) return;
    try {
      const rebased = await rebaseStoryboardConflict({
        projectId, getCurrent: () => storyboardRef.current!, dirtySceneIds: dirtySceneIds.current,
        preserveLocalOrder: orderDirty.current, fetcher: (url) => fetch(url)
      });
      storyboardRef.current = rebased;
      setStoryboard(rebased);
      setMessage('This film changed elsewhere. Your edits are preserved with the latest version. Review them, then save again.');
    } catch {
      setMessage('This film changed elsewhere. Your edits are still here, but the latest version could not be loaded.');
    }
  };

  const moveScene = (sceneId: string, offset: number) => setStoryboard((current) => {
    if (!current) return current;
    const from = current.scenes.findIndex((scene) => scene.id === sceneId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= current.scenes.length) return current;
    const scenes = [...current.scenes];
    const [moving] = scenes.splice(from, 1);
    scenes.splice(to, 0, moving);
    orderDirty.current = true;
    orderGeneration.current += 1;
    const next = {...current, scenes};
    storyboardRef.current = next;
    return next;
  });

  const sourceOptions = buildStoryboardOptions(projectId, availableAssets, evidence);

  const saveConsent = async (
    purpose: 'storage' | 'processing',
    permissionConfirmed: boolean
  ) => {
    if (!permissionConfirmed) {
      setMessage('Please confirm that you have permission before saving.');
      return;
    }
    const storage = purpose === 'storage';
    const response = await fetch(`/api/projects/${projectId}/consent`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        purpose,
        documentVersion: '2026-07-14.1',
        providers: storage
          ? ['google_cloud_storage']
          : ['google_gemini', 'deepgram', 'openai'],
        dataCategories: storage
          ? ['original_media', 'derived_media']
          : processingConsentDataCategories,
        permissionConfirmed
      })
    });
    setMessage(response.ok
      ? `${storage ? 'Storage' : 'Processing'} choices saved. Nothing starts automatically.`
      : `The ${storage ? 'storage' : 'processing'} choices could not be saved.`);
  };

  return (
    <main className="project-form-page">
      <nav aria-label="Chapter progress" className="chapter-stepper">
        <ol>{['Pieces', 'Story', 'Questions', 'Record', 'Film'].map((step) => <li key={step}>{step}</li>)}</ol>
      </nav>
      <section aria-labelledby="gather-title">
        <p className="eyebrow">Gather the pieces</p>
        <h1 id="gather-title">Bring the chapter together.</h1>
        <p className="dek">
          Choose three to seven family photographs, then add what you know.
        </p>
        <section aria-labelledby="storage-consent-title" className="record-card">
          <h2 id="storage-consent-title">Keep your family pieces private</h2>
          <p>
            Private originals and derivatives are stored in Google Cloud Storage.
            This is storage only; it is separate from the Gemini Developer API.
          </p>
          <p>
            Data stored: original photographs, recordings, written artifacts, and
            private derived media.
          </p>
          <p><a href="https://cloud.google.com/terms/cloud-privacy-notice" target="_blank" rel="noreferrer">Google Cloud privacy information</a></p>
          <label>
            <input type="checkbox" checked={storagePermission} onChange={(event) => setStoragePermission(event.target.checked)} />
            I have permission to upload and store this material.
          </label>
          <button type="button" onClick={() => saveConsent('storage', storagePermission)}>Save storage choice</button>
        </section>
        <section aria-labelledby="processing-consent-title" className="record-card">
          <h2 id="processing-consent-title">Choose external processing</h2>
          <p>
            This project sends selected information to third-party processors. By
            continuing, you confirm that you have permission to submit this material.
          </p>
          <ul>
            <li><strong>Google Gemini Developer API:</strong> selected photos, captions, written artifacts, transcripts, and approved story context for analysis and story composition. Gemini has no regional data-residency promise. <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">Privacy and terms</a></li>
            <li><strong>Deepgram:</strong> source recordings or creator-provided narration for transcription; approved narration text and the Arcas voice setting for narration. <a href="https://deepgram.com/privacy" target="_blank" rel="noreferrer">Privacy information</a></li>
            <li><strong>OpenAI:</strong> only the approved evidence ledger, source references, and final narration text for factuality review. <a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">Privacy information</a></li>
            <li><strong>Microsoft Azure (optional, not currently selected):</strong> only approved narration text and voice settings after you explicitly select Azure. <a href="https://privacy.microsoft.com/privacystatement" target="_blank" rel="noreferrer">Privacy information</a></li>
          </ul>
          <label>
            <input type="checkbox" checked={processingPermission} onChange={(event) => setProcessingPermission(event.target.checked)} />
            I have permission to submit this material to the listed processors.
          </label>
          <button type="button" onClick={() => saveConsent('processing', processingPermission)}>Save processing choice</button>
        </section>
        <form onSubmit={gather}>
          <label>
            Family photographs (3–7)
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              required
              onChange={chooseImages}
            />
          </label>
          <div aria-label="Photograph slots">
            {Array.from({length: 7}, (_, index) => {
              const draft = images[index];
              return draft ? (
                <fieldset key={draft.previewUrl}>
                  <legend>Photograph {index + 1}</legend>
                  {/* The local object URL is only a thumbnail preview. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={draft.previewUrl} alt="Selected family photograph" width={180} />
                  <progress value={draft.progress} max={100}>
                    {draft.progress}%
                  </progress>
                  <span>{draft.status}</span>
                  <label>
                    Caption
                    <input
                      value={draft.caption}
                      onChange={(event) =>
                        updateImage(index, {caption: event.target.value})
                      }
                    />
                  </label>
                  <label>
                    Approximate date
                    <input
                      value={draft.capturedAtText}
                      onChange={(event) =>
                        updateImage(index, {capturedAtText: event.target.value})
                      }
                    />
                  </label>
                  <label>
                    Known people (comma separated)
                    <input
                      value={draft.knownPeople}
                      onChange={(event) =>
                        updateImage(index, {knownPeople: event.target.value})
                      }
                    />
                  </label>
                </fieldset>
              ) : (
                <div key={index} aria-label={`Empty photograph slot ${index + 1}`}>
                  Photograph {index + 1} {index < 3 ? '(needed)' : '(optional)'}
                </div>
              );
            })}
          </div>
          <label>
            Supporting text (optional)
            <textarea
              rows={8}
              value={supportingText}
              onChange={(event) => {
                setSupportingText(event.target.value);
                setTextStatus(createWaitingUploadStatus());
              }}
            />
          </label>
          {supportingText && (
            <>
              <pre aria-label="Supporting text preview">{supportingText}</pre>
              <progress value={textStatus.progress} max={100}>
                {textStatus.progress}%
              </progress>
              <span>{textStatus.status}</span>
            </>
          )}
          <label>
            A short family recording (optional)
            <input
              type="file"
              accept="audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/webm,audio/ogg"
              onChange={(event) => {
                setSourceAudio(event.target.files?.[0] ?? null);
                setAudioStatus(createWaitingUploadStatus());
              }}
            />
            {sourceAudio && (
              <>
                <progress value={audioStatus.progress} max={100}>
                  {audioStatus.progress}%
                </progress>
                <span>{audioStatus.status}</span>
              </>
            )}
          </label>
          <p role="status">{message}</p>
          <button type="submit">Preserve these pieces</button>
        </form>
      </section>
      <section aria-labelledby="story-review-title" className="story-workflow">
        <p className="eyebrow">Shape the chapter</p>
        <h2 id="story-review-title">Keep every detail true to your family.</h2>
        <div className="workflow-actions">
          <button type="button" onClick={findStory}>Find the story</button>
          <button type="button" onClick={loadEvidence}>Review the record</button>
          <button type="button" onClick={generateQuestions}>Prepare my questions</button>
          <button type="button" onClick={composeStoryboard}>Shape the film</button>
        </div>

        {evidence.length > 0 && <section aria-labelledby="record-title">
          <h3 id="record-title">Review the record</h3>
          {evidence.map((item) => { const display = displayEvidenceClaim(item); return <article key={item.id} className="record-card">
            <p>{item.kind === 'model_hypothesis' || item.verificationStatus === 'proposed' ? <strong>Needs your help</strong> : <strong>{item.verificationStatus}</strong>}</p>
            <p>{display.current}</p>
            {display.originallyProposed && <p><small>Originally proposed: {display.originallyProposed}</small></p>}
            {item.verificationStatus === 'proposed' && <>
              <button type="button" onClick={() => reviewEvidence(item, 'confirm')}>Confirm fact</button>
              <label>Correction
                <input value={corrections[item.id] ?? ''} onChange={(event) => setCorrections((current) => ({...current, [item.id]: event.target.value}))} />
              </label>
              <button type="button" disabled={!corrections[item.id]?.trim()} onClick={() => reviewEvidence(item, 'correct')}>Save correction</button>
              <button type="button" onClick={() => reviewEvidence(item, 'reject')}>Reject suggestion</button>
            </>}
          </article>; })}
        </section>}

        {questions.length > 0 && <section aria-labelledby="questions-title">
          <h3 id="questions-title">A few details need your help</h3>
          <ol>{questions.slice(0, 5).map((question) => <li key={question.id}><p>{question.question}</p><small>Needs your help: {question.reason}</small>
            <label>Your answer<textarea value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({...current, [question.id]: event.target.value}))} /></label>
            <button type="button" disabled={!answers[question.id]?.trim()} onClick={() => saveAnswer(question.id)}>Save answer</button>
          </li>)}</ol>
        </section>}

        {storyboard && <section aria-labelledby="film-title">
          <h3 id="film-title">Film</h3>
          <p>{storyboard.title} · about {Math.round(storyboard.targetDurationSeconds / 60)} minutes</p>
          <h4>Written voice</h4>
          {storyboard.voiceProfile.traits.length ? <ul>{storyboard.voiceProfile.traits.map((trait) => <li key={trait.trait}><strong>{trait.trait}</strong>: {trait.description} <small>Based on {trait.evidenceItemIds.length} approved source{trait.evidenceItemIds.length === 1 ? '' : 's'}.</small></li>)}</ul> : <p>A restrained editorial voice will keep the story grounded.</p>}
          <ol className="scene-list" aria-label="Film scenes">
            {storyboard.scenes.map((scene, index) => <li key={scene.id} draggable
              onDragStart={() => { draggedSceneId.current = scene.id; }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                const dragged = draggedSceneId.current;
                if (!dragged || dragged === scene.id) return;
                orderDirty.current = true;
                orderGeneration.current += 1;
                setStoryboard((current) => {
                  if (!current) return current;
                  const moving = current.scenes.find((entry) => entry.id === dragged);
                  if (!moving) return current;
                  const without = current.scenes.filter((entry) => entry.id !== dragged);
                  without.splice(index, 0, moving);
                  const next = {...current, scenes: without};
                  storyboardRef.current = next;
                  return next;
                });
              }}>
              <span aria-label={`Drag scene ${index + 1}`}>↕ Scene {index + 1}</span>
              <button type="button" disabled={index === 0} onClick={() => moveScene(scene.id, -1)} aria-label={`Move scene ${index + 1} earlier`}>Move earlier</button>
              <button type="button" disabled={index === storyboard.scenes.length - 1} onClick={() => moveScene(scene.id, 1)} aria-label={`Move scene ${index + 1} later`}>Move later</button>
              <label>Scene type<select value={scene.sceneType} onChange={(event) => updateSceneDraft(scene.id, {sceneType: event.target.value as typeof scene.sceneType})}>
                {['title', 'media', 'original_audio', 'dedication', 'credits'].map((value) => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}
              </select></label>
              <label>Scene title<input value={scene.title} onChange={(event) => updateSceneDraft(scene.id, {title: event.target.value})} /></label>
              <label>Narration<textarea value={scene.narrationText} onChange={(event) => updateSceneDraft(scene.id, {narrationText: event.target.value})} /></label>
              <label>Caption<input value={scene.captionText} onChange={(event) => updateSceneDraft(scene.id, {captionText: event.target.value})} /></label>
              <label>Duration in seconds<input type="number" min="1" max="240" step="0.5" value={scene.durationSeconds} onChange={(event) => updateSceneDraft(scene.id, {durationSeconds: Number(event.target.value)})} /></label>
              <fieldset><legend>Pictures and recordings</legend>
                {sourceOptions.assets.length ? sourceOptions.assets.map((option) => <label key={option.id}>
                  <input type="checkbox" checked={scene.assetIds.includes(option.id)} onChange={(event) => updateSceneDraft(scene.id, {assetIds: event.target.checked ? [...new Set([...scene.assetIds, option.id])] : scene.assetIds.filter((id) => id !== option.id)})} />
                  {option.label}
                </label>) : <p>Review the record to load available pieces.</p>}
              </fieldset>
              <fieldset><legend>Details supporting this scene</legend>
                {sourceOptions.evidence.length ? sourceOptions.evidence.map((option) => <label key={option.id}>
                  <input type="checkbox" checked={scene.evidenceItemIds.includes(option.id)} onChange={(event) => updateSceneDraft(scene.id, {evidenceItemIds: event.target.checked ? [...new Set([...scene.evidenceItemIds, option.id])] : scene.evidenceItemIds.filter((id) => id !== option.id)})} />
                  {option.label}
                </label>) : <p>Confirm details in the record before selecting them.</p>}
              </fieldset>
              <label>Motion<select value={scene.motionPreset} onChange={(event) => updateSceneDraft(scene.id, {motionPreset: event.target.value as typeof scene.motionPreset})}>
                {['hold', 'slow_zoom_in', 'slow_pan_left', 'slow_pan_right'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
              </select></label>
              <label>Transition<select value={scene.transitionPreset} onChange={(event) => updateSceneDraft(scene.id, {transitionPreset: event.target.value as typeof scene.transitionPreset})}>
                {['crossfade', 'fade_to_black'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
              </select></label>
              <button type="button" onClick={() => saveScene(scene.id)}>Save scene</button>
              <button type="button" onClick={() => regenerateScene(scene.id)}>Regenerate this scene</button>
            </li>)}
          </ol>
          <button type="button" onClick={saveOrder}>Save scene order</button>
        </section>}
      </section>
      <section aria-labelledby="provider-activity-title" className="record-card">
        <h2 id="provider-activity-title">External processing activity</h2>
        <p>Estimate, not final billing.</p>
        {providerRuns.length === 0 ? <p>No external processing has been requested.</p> : <ul>
          {providerRuns.map((run) => <li key={run.id}>
            <strong>{run.operation.replaceAll('_', ' ')}</strong> · {run.provider} · {run.status} · cache reuse {run.cacheHitCount} · requests {run.requestCount} · estimated ${(run.estimatedCostMicros / 1_000_000).toFixed(4)}{run.settledCostMicros !== null ? ` · observed $${(run.settledCostMicros / 1_000_000).toFixed(4)}${run.settledCostMicros > run.estimatedCostMicros ? ' (over estimate)' : ''}` : ''}
          </li>)}
        </ul>}
      </section>
    </main>
  );
}
