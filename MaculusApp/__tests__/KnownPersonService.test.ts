import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFile, writeFile } from '@dr.pogodin/react-native-fs';
import { KnownPersonService, normalizePersonName } from '../src/services/KnownPersonService';

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;

describe('KnownPersonService', () => {
  beforeEach(() => {
    mockReadFile.mockReset().mockRejectedValue(Object.assign(new Error('missing'), {code: 'ENOENT'}));
    mockWriteFile.mockReset().mockResolvedValue(undefined);
  });

  it('loads valid app-private profiles and ignores malformed records', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      version: 1,
      people: [
        { name: 'Zafry', embedding: [3, 4, 0], samples: 2, updatedAt: 10 },
        { name: '', embedding: [], samples: 1 },
      ],
    }));
    const service = new KnownPersonService();
    await expect(service.load()).resolves.toEqual([
      { name: 'Zafry', embedding: [0.6, 0.8, 0], samples: 2, updatedAt: 10 },
    ]);
  });

  it('replaces an existing name case-insensitively before writing', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      version: 1,
      people: [{ name: 'Zafry', embedding: [1, 0, 0], samples: 2, updatedAt: 10 }],
    }));
    const service = new KnownPersonService();
    await service.load();
    await service.replace({ name: 'zafry', embedding: [0, 2, 0], samples: 1, updatedAt: 20 });
    const stored = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(stored.people).toEqual([
      { name: 'Zafry', embedding: [0, 1, 0], samples: 1, updatedAt: 20 },
    ]);
  });

  it('accepts natural names but rejects punctuation and empty values', () => {
    expect(normalizePersonName('  mary jane ')).toBe('Mary Jane');
    expect(normalizePersonName('../person')).toBeNull();
    expect(normalizePersonName('')).toBeNull();
  });
});
