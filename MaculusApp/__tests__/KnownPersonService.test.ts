import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFile, writeFile } from '@dr.pogodin/react-native-fs';
import { KnownPersonService, normalizePersonName, parseSpelledPersonName } from '../src/services/KnownPersonService';

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

  it('shares in-flight loads and serializes concurrent saves without losing profiles', async () => {
    const service = new KnownPersonService();
    await Promise.all([
      service.replace({name: 'Zafry', embedding: [1, 0, 0], samples: 1, updatedAt: 10}),
      service.replace({name: 'Mary', embedding: [0, 1, 0], samples: 1, updatedAt: 20}),
    ]);
    expect(service.getProfiles().map(item => item.name)).toEqual(['Mary', 'Zafry']);
    expect(JSON.parse(mockWriteFile.mock.calls[1][1]).people).toHaveLength(2);
    expect(mockWriteFile.mock.calls[0][0]).not.toBe(mockWriteFile.mock.calls[1][0]);
  });

  it('recovers the previous snapshot after an interrupted write on app restart', async () => {
    const files = new Map<string, string>();
    mockReadFile.mockImplementation(async path => {
      if (!files.has(path)) {throw Object.assign(new Error('missing'), {code: 'ENOENT'});}
      return files.get(path)!;
    });
    mockWriteFile.mockImplementation(async (path, contents) => {files.set(path, contents);});
    const service = new KnownPersonService();
    await service.replace({name: 'Zafry', embedding: [1, 0, 0], samples: 1, updatedAt: 10});
    mockWriteFile.mockImplementationOnce(async (path) => {
      files.set(path, '{broken');
      throw new Error('disk full');
    });
    await expect(service.replace({name: 'Mary', embedding: [0, 1, 0], samples: 1, updatedAt: 20})).rejects.toThrow('disk full');
    expect(service.getProfiles().map(item => item.name)).toEqual(['Zafry']);
    expect((await new KnownPersonService().load()).map(item => item.name)).toEqual(['Zafry']);
  });

  it('removes the previous spelling when renaming a saved person', async () => {
    const service = new KnownPersonService();
    await service.replace({name: 'Meri', embedding: [1, 0, 0], samples: 1, updatedAt: 1});
    await service.replace({name: 'Mary', embedding: [1, 0, 0], samples: 1, updatedAt: 2}, 'Meri');
    expect(service.getProfiles().map(item => item.name)).toEqual(['Mary']);
  });

  it('does not overwrite an unreadable store', async () => {
    mockReadFile.mockRejectedValue(new Error('permission denied'));
    await expect(new KnownPersonService().replace({name: 'Zafry', embedding: [1, 0, 0], samples: 1, updatedAt: 1})).rejects.toThrow('permission denied');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('accepts natural names but rejects punctuation and empty values', () => {
    expect(normalizePersonName('  mary jane ')).toBe('Mary Jane');
    expect(normalizePersonName('../person')).toBeNull();
    expect(normalizePersonName('')).toBeNull();
  });
});


describe('General name spelling', () => {
  it.each([
    ['Z A F R Y', 'Zafry'], ['M-A-R-Y', 'Mary'], ['spelled zee ay eff ar why', 'Zafry'],
    ['spelled bee ee en', 'Ben'], ['M. A. R. Y.', 'Mary'],
  ])('parses %s as letters', (input, expected) => {
    expect(parseSpelledPersonName(input)).toBe(expected);
  });
  it.each(['a free', 'Mary Jane', 'spelled maybe', 'Zebra April'])('never guesses a spelling from %s', input => {
    expect(parseSpelledPersonName(input)).toBeNull();
  });
});
