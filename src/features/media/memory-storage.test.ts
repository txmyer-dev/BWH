import {describe, expect, it} from 'vitest';

import {MemoryStorage} from './memory-storage';

describe('MemoryStorage', () => {
  it('models create-only original uploads', () => {
    const storage = new MemoryStorage();
    storage.upload('projects/project/originals/asset.jpg', 10, 'image/jpeg');

    expect(() =>
      storage.upload('projects/project/originals/asset.jpg', 11, 'image/jpeg')
    ).toThrow('OBJECT_ALREADY_EXISTS');
  });
});
