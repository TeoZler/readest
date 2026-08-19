import { md5 } from 'js-md5';

export function createKavitaServerId(): string {
  return crypto.randomUUID();
}

export function createKavitaBookId(serverId: string, chapterId: number): string {
  return md5(`kavita:${serverId}:${chapterId}`);
}
