import {Composition, registerRoot} from 'remotion';

import {MemoryFilm} from './composition';
import type {MemoryFilmProps} from './manifest';

const defaultProps: MemoryFilmProps = {
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  projectId: '11111111-1111-4111-8111-111111111111',
  storyboardId: '22222222-2222-4222-8222-222222222222',
  storyboardRevision: 0,
  auditId: '33333333-3333-4333-8333-333333333333',
  evidenceHash: '0'.repeat(64),
  narrationHash: '0'.repeat(64),
  title: 'The Legacy Studio',
  subjectName: 'A life remembered',
  dedication: '',
  disclosure: 'A private family keepsake.',
  totalFrames: 1,
  manifestHash: '0'.repeat(64),
  creatorNarrationUrl: null,
  scenes: []
};

export const RemotionRoot = () => <Composition
  id="MemoryFilm"
  component={MemoryFilm}
  width={1920}
  height={1080}
  fps={30}
  durationInFrames={1}
  defaultProps={defaultProps}
  calculateMetadata={({props}) => ({durationInFrames: props.totalFrames})}
/>;

registerRoot(RemotionRoot);
