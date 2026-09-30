/** Remove parâmetros: "audio/ogg; codecs=opus" → "audio/ogg" */
export function baseMime(mime: string | undefined, fallback: string): string {
  return (mime ?? fallback).split(';')[0]!.trim().toLowerCase() || fallback;
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'audio/webm': 'webm', 'audio/wav': 'wav', 'application/pdf': 'pdf',
  };
  return map[mime] ?? 'bin';
}

/** Formatos de imagem que o Claude aceita. */
export const CLAUDE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ClaudeImageType = (typeof CLAUDE_IMAGE_TYPES)[number];

export function isClaudeImage(mime: string): mime is ClaudeImageType {
  return (CLAUDE_IMAGE_TYPES as readonly string[]).includes(mime);
}
