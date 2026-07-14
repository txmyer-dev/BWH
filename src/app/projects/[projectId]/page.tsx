'use client';

import {
  use,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent
} from 'react';

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

type ExtraStatus = {
  progress: number;
  status: 'waiting' | 'uploading' | 'ready' | 'failed';
  reservationId?: string;
};

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
  const [textStatus, setTextStatus] = useState<ExtraStatus>({
    progress: 0,
    status: 'waiting'
  });
  const [audioStatus, setAudioStatus] = useState<ExtraStatus>({
    progress: 0,
    status: 'waiting'
  });
  const [message, setMessage] = useState('Add at least three photographs.');
  const previewUrls = useRef<string[]>([]);

  useEffect(
    () => () => {
      previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    []
  );

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
        await upload(
          sourceAudio,
          {
            kind: 'source_audio',
            name: sourceAudio.name,
            contentType: sourceAudio.type,
            size: sourceAudio.size,
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

  return (
    <main className="project-form-page">
      <section aria-labelledby="gather-title">
        <p className="eyebrow">Gather the pieces</p>
        <h1 id="gather-title">Bring the chapter together.</h1>
        <p className="dek">
          Choose three to seven family photographs, then add what you know.
        </p>
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
              onChange={(event) => setSupportingText(event.target.value)}
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
              onChange={(event) => setSourceAudio(event.target.files?.[0] ?? null)}
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
    </main>
  );
}
