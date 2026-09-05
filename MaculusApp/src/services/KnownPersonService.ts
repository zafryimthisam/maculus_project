import { DocumentDirectoryPath, readFile, writeFile } from '@dr.pogodin/react-native-fs';

export interface KnownPersonProfile {
  name: string;
  embedding: number[];
  samples: number;
  updatedAt: number;
}

const STORE_PATH = `${DocumentDirectoryPath}/maculus-known-people.json`;
const MAX_PROFILES = 100;

export class KnownPersonService {
  private profiles: KnownPersonProfile[] = [];
  private loaded = false;
  private revision = 0;

  private loading: Promise<KnownPersonProfile[]> | null = null;
  private writes: Promise<void> = Promise.resolve();

  async load(): Promise<KnownPersonProfile[]> {
    if (this.loaded) {return this.getProfiles();}
    if (this.loading) {return this.loading;}
    this.loading = (async () => {
      const snapshots = await Promise.all([STORE_PATH, `${STORE_PATH}.backup`].map(async path => {
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8'));
          if (!Array.isArray(parsed.people)) {throw new Error('Invalid saved person store.');}
          return {people: parsed.people as unknown[], revision: Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0};
        } catch (error: any) {
          return {error};
        }
      }));
      const valid = snapshots.filter((item): item is {people: unknown[]; revision: number} => 'people' in item)
        .sort((a, b) => b.revision - a.revision);
      if (valid.length) {
        this.revision = valid[0].revision;
        this.profiles = valid[0].people.map(validateProfile)
          .filter((item): item is KnownPersonProfile => Boolean(item)).slice(0, MAX_PROFILES);
      } else {
        const failed = snapshots.find(item => 'error' in item && item.error?.code !== 'ENOENT');
        if (failed && 'error' in failed) {throw failed.error;}
        this.profiles = [];
      }
      this.loaded = true;
      return this.getProfiles();
    })();
    try {return await this.loading;} finally {this.loading = null;}
  }

  getProfiles(): KnownPersonProfile[] {
    return this.profiles.map(profile => ({ ...profile, embedding: [...profile.embedding] }));
  }

  async replace(profile: KnownPersonProfile, previousName?: string): Promise<void> {
    const valid = validateProfile(profile);
    if (!valid) {throw new Error('The person identity is not valid.');}
    const operation = this.writes.then(async () => {
      await this.load();
      const key = valid.name.toLocaleLowerCase();
      const next = [valid, ...this.profiles.filter(item => item.name.toLocaleLowerCase() !== key &&
        item.name.toLocaleLowerCase() !== previousName?.toLocaleLowerCase())]
        .slice(0, MAX_PROFILES);
      // Alternate complete snapshots. An interrupted write leaves the previous
      // revision readable on both platforms (iOS moveFile cannot overwrite).
      const revision = this.revision + 1;
      const destination = revision % 2 ? `${STORE_PATH}.backup` : STORE_PATH;
      await writeFile(destination, JSON.stringify({ version: 1, revision, people: next }), 'utf8');
      this.profiles = next;
      this.revision = revision;
    });
    this.writes = operation.catch(() => undefined);
    await operation;
  }
}

function validateProfile(value: any): KnownPersonProfile | null {
  const name = typeof value?.name === 'string' ? normalizePersonName(value.name) : null;
  if (!name || !Array.isArray(value?.embedding) || value.embedding.length < 3 ||
      !value.embedding.every((item: unknown) => typeof item === 'number' && Number.isFinite(item))) {return null;}
  const magnitude = Math.sqrt(value.embedding.reduce((sum: number, item: number) => sum + item * item, 0));
  if (!magnitude) {return null;}
  return {
    name,
    embedding: value.embedding.map((item: number) => item / magnitude),
    samples: Math.max(1, Math.floor(Number(value.samples) || 1)),
    updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : Date.now(),
  };
}

/** Parse explicit letter-by-letter input without guessing or substituting a name. */
export function parseSpelledPersonName(value: string): string | null {
  const explicit = /^spelled\s+/i.test(value.trim());
  const tokens = value.trim().replace(/^spelled\s+/i, '').replace(/[.!?]+$/, '')
    .split(/[\s,.-]+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 50) {return null;}
  const spokenLetters: Record<string, string> = {
    ay: 'a', bee: 'b', cee: 'c', dee: 'd', ee: 'e', eff: 'f', gee: 'g',
    aitch: 'h', haitch: 'h', eye: 'i', jay: 'j', kay: 'k', el: 'l', ell: 'l',
    em: 'm', en: 'n', oh: 'o', pee: 'p', cue: 'q', queue: 'q', ar: 'r',
    ess: 's', tee: 't', you: 'u', vee: 'v', ex: 'x', why: 'y', zee: 'z', zed: 'z',
  };
  const letters = tokens.map(token => /^[a-z]$/i.test(token) ? token.toLowerCase()
    : explicit ? spokenLetters[token.toLowerCase()] : undefined);
  if (letters.some(letter => !letter)) {return null;}
  return normalizePersonName(letters.join(''));
}

export function normalizePersonName(value: string): string | null {
  const cleaned = value.replace(/^[\s"']+|[\s"'.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 50 || !/^[\p{L}\p{M}][\p{L}\p{M}\p{N} _-]*$/u.test(cleaned)) {return null;}
  return cleaned.split(' ').map(part => part ? part[0].toLocaleUpperCase() + part.slice(1) : part).join(' ');
}

export const knownPersonService = new KnownPersonService();
