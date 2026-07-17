import {describe, expect, it, vi} from 'vitest';

import type {RenderJobLauncher} from './cloud-run-render-launcher';
import {buildRenderManifest, type FilmSource} from './manifest';
import {InMemoryRenderJobRepository} from './render-job-repository';
import {InMemoryFilmRepository} from './render-service';
import {RenderCoordinator} from './render-coordinator';

const projectId = '11111111-1111-4111-8111-111111111111';

const source = (): FilmSource => ({
  projectId,
  storyboardId: '22222222-2222-4222-8222-222222222222',
  storyboardRevision: 3,
  auditId: '33333333-3333-4333-8333-333333333333',
  evidenceHash: 'c'.repeat(64),
  narrationHash: 'd'.repeat(64),
  title: 'A Chapter Together',
  subjectName: 'June',
  dedication: '',
  disclosure: 'Narration created with a generated voice from Deepgram.',
  auditPassed: true,
  textApproved: true,
  audioApproved: true,
  creatorNarrationObjectKey: null,
  scenes: [0, 1, 2].map((index) => ({
    id: `44444444-4444-4444-8444-44444444444${index}`,
    sceneType: index === 0 ? 'title' : index === 2 ? 'credits' : 'media',
    title: `Scene ${index + 1}`,
    narrationText: index === 1 ? 'A true memory.' : '',
    captionText: '',
    durationSeconds: 40,
    imageObjectKeys: index === 1 ? ['projects/private/image.jpg'] : [],
    narrationObjectKey: index === 1 ? 'projects/private/voice.wav' : null,
    authenticClip: null,
    motionPreset: 'hold',
    transitionPreset: 'crossfade'
  }))
});

const setup = () => {
  const films = new InMemoryFilmRepository();
  films.seed(source());
  const jobs = new InMemoryRenderJobRepository();
  const launcher: RenderJobLauncher = {launch: vi.fn(async () => undefined)};
  const assertOwner = vi.fn(async () => undefined);
  const coordinator = new RenderCoordinator(films, jobs, launcher, assertOwner);
  return {films, jobs, launcher, assertOwner, coordinator};
};

describe('RenderCoordinator', () => {
  it('reuses a completed render with the current manifest', async () => {
    const {coordinator, films, jobs, launcher} = setup();
    const manifest = buildRenderManifest(source());
    await films.saveCompleted(projectId, manifest, 'projects/private/render.mp4');

    await expect(coordinator.request(projectId)).resolves.toEqual({
      status: 'completed', manifestHash: manifest.manifestHash, reused: true
    });
    expect(launcher.launch).not.toHaveBeenCalled();
    expect(await jobs.latest(projectId)).toBeUndefined();
  });

  it('returns after scheduling one new render', async () => {
    const {coordinator, launcher} = setup();

    const result = await coordinator.request(projectId);

    expect(result).toMatchObject({status: 'pending', created: true});
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it('does not launch a duplicate active render', async () => {
    const {coordinator, launcher} = setup();

    await coordinator.request(projectId);
    await coordinator.request(projectId);

    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it('marks a pending record failed when launch is rejected', async () => {
    const {coordinator, jobs, launcher} = setup();
    vi.mocked(launcher.launch).mockRejectedValueOnce(new Error('internal detail'));

    await expect(coordinator.request(projectId)).rejects.toThrow('RENDER_JOB_LAUNCH_FAILED');
    expect(await jobs.latest(projectId)).toMatchObject({status: 'failed', lastError: 'RENDER_JOB_LAUNCH_FAILED'});
  });

  it('asserts ownership before loading render source or job status', async () => {
    const {coordinator, films, jobs, assertOwner} = setup();
    assertOwner.mockRejectedValue(new Error('PROJECT_FORBIDDEN'));
    const latest = vi.spyOn(jobs, 'latest');

    await expect(coordinator.request(projectId)).rejects.toThrow('PROJECT_FORBIDDEN');
    await expect(coordinator.status(projectId)).rejects.toThrow('PROJECT_FORBIDDEN');

    expect(films.loadCalls).toBe(0);
    expect(latest).not.toHaveBeenCalled();
  });

  it.each([
    ['RENDER_JOB_LAUNCH_FAILED', 'RENDER_JOB_LAUNCH_FAILED'],
    ['RENDER_SUPERSEDED', 'RENDER_SUPERSEDED'],
    ['provider leaked private detail', 'RENDER_EXECUTION_FAILED']
  ])('normalizes the status error %s', async (lastError, error) => {
    const {coordinator, jobs} = setup();
    const requested = await jobs.request(projectId);
    await jobs.failPendingLaunch(requested.job.id, lastError);

    await expect(coordinator.status(projectId)).resolves.toEqual({
      jobId: requested.job.id, status: 'failed', attemptCount: 0, error
    });
  });

  it('reports superseded status without exposing repository-only fields', async () => {
    const {coordinator, jobs} = setup();
    const requested = await jobs.request(projectId);
    await jobs.supersedeProject(projectId);

    await expect(coordinator.status(projectId)).resolves.toEqual({
      jobId: requested.job.id, status: 'superseded', attemptCount: 0, error: 'RENDER_SUPERSEDED'
    });
  });
});
