export type UploadStatus = {
  progress: number;
  status: 'waiting' | 'uploading' | 'ready' | 'failed';
  reservationId?: string;
};

export const createWaitingUploadStatus = (): UploadStatus => ({
  progress: 0,
  status: 'waiting'
});
