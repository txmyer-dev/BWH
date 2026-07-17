export type PersistedAssetSummary = {
  id: string;
  kind: string;
  processingStatus: string;
  caption: string | null;
  sequenceOrder: number;
};

export type ImageSlot =
  | {kind: 'empty'}
  | {kind: 'persisted'; assetId: string; status: string; label: string};

export const hydrateImageSlots = (
  assets: PersistedAssetSummary[],
  count = 7
): ImageSlot[] => {
  const slots: ImageSlot[] = Array.from(
    {length: count},
    () => ({kind: 'empty'})
  );
  for (const asset of assets) {
    if (
      asset.kind !== 'image' ||
      asset.sequenceOrder < 0 ||
      asset.sequenceOrder >= count
    ) {
      continue;
    }
    slots[asset.sequenceOrder] = {
      kind: 'persisted',
      assetId: asset.id,
      status: asset.processingStatus,
      label: asset.caption?.trim() || `Photograph ${asset.sequenceOrder + 1}`
    };
  }
  return slots;
};

export const mergeLocalImageDraft = <Draft>(
  slot: ImageSlot,
  draft: Draft | undefined
): ImageSlot | Draft => draft ?? slot;
