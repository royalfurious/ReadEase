import { NextResponse } from 'next/server';

const DEFAULT_LIBRETRANSLATE_URL = 'https://libretranslate.de/translate';
const FALLBACK_LIBRETRANSLATE_URLS = [
  'https://libretranslate.de/translate',
  'https://translate.astian.org/translate',
];

async function translateMyMemory(text: string, targetLang: string) {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `en|${targetLang}`);

  const res = await fetchWithTimeout(
    url.toString(),
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    },
    12_000
  );

  if (!res.ok) throw new Error('Translation provider error');

  const body = (await res.json().catch(() => null)) as
    | { responseData?: { translatedText?: string } }
    | null;
  const translatedText = body?.responseData?.translatedText?.trim();
  if (!translatedText) throw new Error('No translation returned');
  return translatedText;
}

async function fetchWithTimeout(input: string, init: RequestInit, ms: number) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

function isSingleWord(text: string) {
  return /^[A-Za-z]+(?:[-'][A-Za-z]+)?$/.test(text.trim());
}

async function translateLibreTranslate(text: string, targetLang: string) {
  const apiKey = process.env.LIBRETRANSLATE_API_KEY;

  const configured = (process.env.LIBRETRANSLATE_URL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const urls = configured.length
    ? configured
    : Array.from(new Set([DEFAULT_LIBRETRANSLATE_URL, ...FALLBACK_LIBRETRANSLATE_URLS]));

  let lastErr: unknown = null;

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            q: text,
            source: 'en',
            target: targetLang,
            format: 'text',
            ...(apiKey ? { api_key: apiKey } : null),
          }),
          cache: 'no-store',
        },
        12_000
      );

      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();

      if (raw.trim().startsWith('<')) {
        // Public instances often return an informational HTML page when rate-limited.
        throw new Error(
          'LibreTranslate requires an API key (public endpoint is rate-limited). Set LIBRETRANSLATE_URL and LIBRETRANSLATE_API_KEY.'
        );
      }

      const maybeJson = contentType.includes('application/json')
        ? (JSON.parse(raw) as any)
        : raw.trim().startsWith('{')
          ? (JSON.parse(raw) as any)
          : null;

      if (!res.ok) {
        const providerMsg =
          (typeof maybeJson?.error === 'string' && maybeJson.error) ||
          (typeof maybeJson?.message === 'string' && maybeJson.message) ||
          null;
        throw new Error(providerMsg ?? 'Translation provider error');
      }

      const translatedText = (maybeJson?.translatedText as string | undefined)?.trim();
      if (!translatedText) {
        throw new Error(
          'Translation provider returned an unexpected response. Configure LIBRETRANSLATE_URL.'
        );
      }

      return translatedText;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  if (lastErr instanceof Error) throw lastErr;
  throw new Error('Translation provider error');
}

async function translateSmart(text: string, targetLang: string) {
  try {
    return await translateLibreTranslate(text, targetLang);
  } catch {
    // No-key fallback so the app works out-of-the-box.
    return await translateMyMemory(text, targetLang);
  }
}

async function explainSimpleEnglish(text: string) {
  const trimmed = text.trim();

  // Best-effort: for single words, pull a short definition.
  if (isSingleWord(trimmed)) {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(
      trimmed.toLowerCase()
    )}`;

    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as any[];
      const first = body?.[0];
      const meaning = first?.meanings?.[0];
      const def = meaning?.definitions?.[0]?.definition as string | undefined;
      if (def) return def;
    }
  }

  // Fallback: keep it simple (no extra AI dependency).
  return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 160)}…`;
}

export async function POST(req: Request) {
  try {
    const { text, targetLang } = (await req.json()) as {
      text?: unknown;
      targetLang?: unknown;
    };

    if (typeof text !== 'string' || typeof targetLang !== 'string') {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const cleanText = text.trim();
    if (!cleanText) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 });
    }

    if (cleanText.length > 300) {
      return NextResponse.json({ error: 'Selection too long' }, { status: 400 });
    }

    const [translatedText, simpleEnglish] = await Promise.all([
      translateSmart(cleanText, targetLang),
      explainSimpleEnglish(cleanText),
    ]);

    return NextResponse.json({ translatedText, simpleEnglish });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Server error';
    // Keep error messages user-friendly; avoid leaking provider HTML etc.
    const safe = message.includes('Unexpected token')
      ? 'Translation provider returned an invalid response. Try again or configure LIBRETRANSLATE_URL.'
      : message;
    return NextResponse.json({ error: safe }, { status: 500 });
  }
}
