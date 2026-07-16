import type {CSSProperties} from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, useCurrentFrame} from 'remotion';

import type {MemoryFilmProps, ProjectedScene} from './manifest';

export const sceneVisualStyle = (
  preset: ProjectedScene['motionPreset'],
  frame: number,
  durationFrames: number
) => {
  const progress = Math.max(0, Math.min(1, frame / Math.max(1, durationFrames - 1)));
  if (preset === 'slow_zoom_in') return {scale: 1 + progress * 0.06, translateX: 0};
  if (preset === 'slow_pan_left') return {scale: 1.04, translateX: 2 - progress * 4};
  if (preset === 'slow_pan_right') return {scale: 1.04, translateX: -2 + progress * 4};
  return {scale: 1, translateX: 0};
};

const palette = {ink: '#17201d', cream: '#f5efe3', gold: '#b38b52'};

const StoryScene = ({scene, subjectName}: {scene: ProjectedScene; subjectName: string}) => {
  const frame = useCurrentFrame();
  const motion = sceneVisualStyle(scene.motionPreset, frame, scene.durationFrames);
  const fadeFrames = Math.min(24, Math.floor(scene.durationFrames / 4));
  const opacity = interpolate(
    frame,
    [0, fadeFrames, Math.max(fadeFrames, scene.durationFrames - fadeFrames), scene.durationFrames - 1],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  const image = scene.imageUrls[0];
  const imageStyle: CSSProperties = {
    width: '100%', height: '100%', objectFit: 'cover',
    transform: `scale(${motion.scale}) translateX(${motion.translateX}%)`
  };
  const centered = scene.sceneType === 'title' || scene.sceneType === 'dedication' || scene.sceneType === 'credits';

  return <AbsoluteFill style={{backgroundColor: palette.ink, color: palette.cream, opacity, overflow: 'hidden'}}>
    {image && <Img src={image} style={imageStyle} />}
    {image && <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(23,32,29,.05), rgba(23,32,29,.78))'}} />}
    <AbsoluteFill style={{padding: 96, justifyContent: centered ? 'center' : 'flex-end', alignItems: centered ? 'center' : 'flex-start', textAlign: centered ? 'center' : 'left'}}>
      {scene.sceneType === 'title' && <div style={{fontSize: 30, letterSpacing: 7, textTransform: 'uppercase', color: palette.gold, marginBottom: 22}}>{subjectName}</div>}
      <div style={{fontFamily: 'Georgia, serif', fontSize: centered ? 78 : 58, lineHeight: 1.08, maxWidth: 1500, textShadow: image ? '0 3px 24px rgba(0,0,0,.65)' : undefined}}>{scene.title}</div>
      {scene.captionText && <div style={{fontFamily: 'Arial, sans-serif', fontSize: 30, marginTop: 24, maxWidth: 1300, lineHeight: 1.35}}>{scene.captionText}</div>}
      {scene.sceneType === 'credits' && <div style={{fontFamily: 'Arial, sans-serif', fontSize: 24, marginTop: 36, opacity: .82}}>Made with care in The Legacy Studio</div>}
    </AbsoluteFill>
    {scene.authenticClip ? <Audio src={scene.authenticClip.url} startFrom={Math.floor(scene.authenticClip.startMs / 1000 * 30)} endAt={Math.ceil(scene.authenticClip.endMs / 1000 * 30)} /> : scene.narrationUrl ? <Audio src={scene.narrationUrl} /> : null}
  </AbsoluteFill>;
};

export const MemoryFilm = (props: MemoryFilmProps) => <AbsoluteFill style={{backgroundColor: palette.ink}}>
  {props.creatorNarrationUrl && <Audio src={props.creatorNarrationUrl} />}
  {props.scenes.map((scene) => <Sequence key={scene.id} from={scene.fromFrame} durationInFrames={scene.durationFrames} premountFor={30}>
    <StoryScene scene={scene} subjectName={props.subjectName} />
  </Sequence>)}
  <AbsoluteFill style={{pointerEvents: 'none', justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 22}}>
    <div style={{fontFamily: 'Arial, sans-serif', fontSize: 16, color: palette.cream, opacity: .55}}>{props.disclosure}</div>
  </AbsoluteFill>
</AbsoluteFill>;
