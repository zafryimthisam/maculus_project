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

  async load(): Promise<KnownPersonProfile[]> {
    if (this.loaded) {return this.getProfiles();}
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(STORE_PATH, 'utf8')) as { people?: unknown[] };
      this.profiles = Array.isArray(parsed.people)
        ? parsed.people.map(validateProfile).filter((item): item is KnownPersonProfile => Boolean(item)).slice(0, MAX_PROFILES)
        : [];
    } catch (error: any) {
      if (error?.code && error.code !== 'ENOENT') {
        console.warn('[KnownPeople] Could not load local identities:', error?.message || error);
      }
      this.profiles = [];
    }
    return this.getProfiles();
  }

  getProfiles(): KnownPersonProfile[] {
    return this.profiles.map(profile => ({ ...profile, embedding: [...profile.embedding] }));
  }

  async replace(profile: KnownPersonProfile): Promise<void> {
    const valid = validateProfile(profile);
    if (!valid) {throw new Error('The person identity is not valid.');}
    const key = valid.name.toLocaleLowerCase();
    this.profiles = [valid, ...this.profiles.filter(item => item.name.toLocaleLowerCase() !== key)]
      .slice(0, MAX_PROFILES);
    await writeFile(STORE_PATH, JSON.stringify({ version: 1, people: this.profiles }), 'utf8');
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

export function normalizePersonName(value: string): string | null {
  const cleaned = value.replace(/^[\s"']+|[\s"'.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 50 || !/^[\p{L}\p{M}][\p{L}\p{M}\p{N} _-]*$/u.test(cleaned)) {return null;}
  return cleaned.split(' ').map(part => part ? part[0].toLocaleUpperCase() + part.slice(1) : part).join(' ');
}

export const knownPersonService = new KnownPersonService();
