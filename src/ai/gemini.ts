import axios, { AxiosError, type AxiosInstance } from 'axios';
import { ExternalServiceError } from '../utils/errors';
import type { Logger } from '../utils/logger';

interface GeminiContentPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  generatedImages?: {
    image?: {
      mimeType?: string;
      imageBytes?: string;
    };
  }[];
}

interface GeminiCandidate {
  finishReason?: string;
  content?: {
    parts?: GeminiContentPart[];
  };
}

interface ExtractedGeminiText {
  text: string;
  finishReason?: string;
}

interface CopyGenerationAttempt {
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
}

interface GeminiGenerateResponseLegacyCompat {
  candidates?: {
    content?: {
      parts?: GeminiContentPart[];
    };
  }[];
}

export interface GeminiConfig {
  apiKey: string;
  textModel: string;
  imageModel: string;
  timeoutMs: number;
}

export class GeminiClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: GeminiConfig, private readonly logger: Logger) {
    this.http = axios.create({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      timeout: config.timeoutMs,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  async generateViralCopy(captionOriginal: string, permalink: string): Promise<string> {
    const basePrompt = [
      'Eres un copywriter experto en futbol y memes para redes sociales.',
      'Genera un caption viral en español para Facebook (máx 280 caracteres).',
      'Reglas: tono picante pero no ofensivo, CTA corto, 3-5 hashtags relevantes, sin inventar resultados deportivos.',
      'El copy debe ser texto completo y cerrar idea (no lo dejes truncado).',
      `Caption original: ${captionOriginal || '(sin caption)'}`,
      `Fuente: ${permalink}`,
      'Entrega solo el texto final del caption.'
    ].join('\n');

    const firstAttempt = await this.generateCopyAttempt({
      prompt: basePrompt,
      maxOutputTokens: 512,
      temperature: 0.9
    });

    let selected = firstAttempt;
    if (isMaxTokensFinish(firstAttempt.finishReason)) {
      this.logger.warn('Gemini copy came back with MAX_TOKENS, retrying with larger output budget', {
        model: this.config.textModel,
        firstLength: firstAttempt.text.length
      });

      const secondAttempt = await this.generateCopyAttempt({
        prompt: `${basePrompt}\nNo cortes frases a la mitad. Termina con un cierre claro.`,
        maxOutputTokens: 1024,
        temperature: 0.8
      });

      if (
        secondAttempt.text &&
        (!isMaxTokensFinish(secondAttempt.finishReason) || secondAttempt.text.length >= firstAttempt.text.length)
      ) {
        selected = secondAttempt;
      }
    }

    let text = normalizeGeneratedCopy(selected.text);
    if (looksLikeTruncatedCopy(text)) {
      this.logger.warn('Gemini copy seems truncated by heuristic; requesting rewrite', {
        model: this.config.textModel,
        length: text.length,
        finishReason: selected.finishReason ?? 'unknown',
        ending: text.slice(-24)
      });

      const repairPrompt = [
        'Reescribe y completa este copy para Facebook sin dejar frases a la mitad.',
        'Máximo 280 caracteres.',
        'Tono futbol + memes, CTA corto, 3-5 hashtags.',
        'Devuelve solo el copy final, completo y listo para publicar.',
        `Borrador truncado o incompleto: ${text}`,
        `Caption original: ${captionOriginal || '(sin caption)'}`,
        `Fuente: ${permalink}`
      ].join('\n');

      const repaired = await this.generateCopyAttempt({
        prompt: repairPrompt,
        maxOutputTokens: 1024,
        temperature: 0.7
      });

      if (repaired.text) {
        text = normalizeGeneratedCopy(repaired.text);
        selected = repaired;
      }
    }

    text = fitMaxLengthWithoutBreakingWords(text, 280);
    if (!text) {
      throw new ExternalServiceError('Gemini no devolvió texto para el copy viral.');
    }

    this.logger.info('Gemini copy generated', {
      model: this.config.textModel,
      length: text.length,
      finishReason: selected.finishReason ?? 'unknown'
    });

    return text;
  }

  async generateViralImage(inputImageBuffer: Buffer, captionOriginal: string): Promise<Buffer> {
    const inputMimeType = detectImageMimeType(inputImageBuffer);

    const prompt = [
      'Edita/genera una imagen para Facebook con estilo NOTICIA DEPORTIVA (editorial), no meme.',
      'Debe conservar la esencia del sujeto original con enfoque fotorealista y periodístico.',
      'Look & feel: cobertura deportiva profesional, composición limpia, color grading natural, nitidez alta.',
      'Prohibido: estilo meme, stickers, globos de diálogo, tipografía caricaturesca, chistes visuales, emojis grandes.',
      'No deformes rostros ni cuerpos; evita estética de caricatura o collage.',
      'Si incluyes texto, que sea solo un titular breve estilo noticiero deportivo, sobrio y legible.',
      'Si la imagen original contiene el logo, marca de agua o texto de "Somos Titanes", elimínalo completamente del resultado final.',
      'Evita marcas registradas, escudos alterados y elementos inventados.',
      `Contexto del caption original: ${captionOriginal || '(sin caption)'}`,
      'Devuelve la mejor imagen final en formato JPG o PNG.'
    ].join('\n');

    const response = await this.generateContent(this.config.imageModel, {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: inputMimeType,
                data: inputImageBuffer.toString('base64')
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        temperature: 0.45
      }
    });

    const imageBuffer = extractImageFromGemini(response);
    if (!imageBuffer) {
      throw new ExternalServiceError(
        'Gemini no devolvió imagen binaria. TODO: valida el modelo configurado en GEMINI_MODEL_IMAGE y sus capacidades de image generation.'
      );
    }

    this.logger.info('Gemini image generated', {
      model: this.config.imageModel,
      outputBytes: imageBuffer.length
    });

    return imageBuffer;
  }

  private async generateCopyAttempt(attempt: CopyGenerationAttempt): Promise<ExtractedGeminiText> {
    const response = await this.generateContent(this.config.textModel, {
      contents: [
        {
          role: 'user',
          parts: [{ text: attempt.prompt }]
        }
      ],
      generationConfig: {
        temperature: attempt.temperature,
        topP: 0.95,
        maxOutputTokens: attempt.maxOutputTokens
      }
    });

    return extractTextFromGemini(response);
  }

  private async generateContent(model: string, body: Record<string, unknown>): Promise<GeminiGenerateResponse> {
    try {
      const response = await this.http.post<GeminiGenerateResponse>(`/models/${model}:generateContent`, body, {
        params: {
          key: this.config.apiKey
        }
      });

      return response.data;
    } catch (error) {
      const details = normalizeAxiosError(error);
      throw new ExternalServiceError(`Gemini API error (${details})`, { cause: error });
    }
  }
}

function extractTextFromGemini(response: GeminiGenerateResponse): ExtractedGeminiText {
  const candidates = response.candidates ?? [];
  let fallback: ExtractedGeminiText = { text: '' };

  for (const candidate of candidates) {
    const text = (candidate.content?.parts ?? [])
      .map((part) => part.text?.trim())
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .trim();

    if (!text) {
      continue;
    }

    if (!isMaxTokensFinish(candidate.finishReason)) {
      return toExtractedText(text, candidate.finishReason);
    }

    if (text.length > fallback.text.length) {
      fallback = toExtractedText(text, candidate.finishReason);
    }
  }

  if (fallback.text.length > 0) {
    return fallback;
  }

  const legacy = response as GeminiGenerateResponseLegacyCompat;
  const legacyText = legacy.candidates?.[0]?.content?.parts
    ?.map((part) => part.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .trim();

  return {
    text: legacyText ?? ''
  };
}

function extractImageFromGemini(response: GeminiGenerateResponse): Buffer | null {
  const parts = response.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    const data = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType ?? '';
    if (data && mimeType.startsWith('image/')) {
      return Buffer.from(data, 'base64');
    }
  }

  const generatedImageBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (generatedImageBytes) {
    return Buffer.from(generatedImageBytes, 'base64');
  }

  return null;
}

function detectImageMimeType(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  return 'image/jpeg';
}

function normalizeAxiosError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const message = error.message;

    if (status) {
      return `${status} ${statusText ?? ''} ${message}`.trim();
    }

    return message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeGeneratedCopy(text: string): string {
  const compact = text
    .replace(/^```[a-zA-Z]*\s*/g, '')
    .replace(/```$/g, '')
    .replace(/\r/g, '')
    .trim();

  return compact.replace(/\n{3,}/g, '\n\n');
}

function isMaxTokensFinish(finishReason: string | undefined): boolean {
  return (finishReason ?? '').toUpperCase() === 'MAX_TOKENS';
}

function toExtractedText(text: string, finishReason: string | undefined): ExtractedGeminiText {
  if (finishReason) {
    return { text, finishReason };
  }
  return { text };
}

function fitMaxLengthWithoutBreakingWords(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const hardCut = text.slice(0, maxLength).trimEnd();
  const lastSpace = hardCut.lastIndexOf(' ');
  if (lastSpace < 40) {
    return hardCut;
  }

  return hardCut.slice(0, lastSpace).trimEnd();
}

function looksLikeTruncatedCopy(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }

  if (normalized.length < 25) {
    return true;
  }

  const lower = normalized.toLowerCase();
  const danglingEndings = new Set([
    'y',
    'o',
    'si',
    'que',
    'de',
    'del',
    'la',
    'el',
    'los',
    'las',
    'un',
    'una',
    'para',
    'con',
    'por',
    'en',
    'al',
    'a',
    'ya',
    'pero'
  ]);

  const lastWord = lower.split(/\s+/).filter(Boolean).at(-1) ?? '';
  if (danglingEndings.has(lastWord)) {
    return true;
  }

  const unbalancedQuotes = (normalized.match(/"/g)?.length ?? 0) % 2 !== 0;
  const unbalancedParens = countChar(normalized, '(') !== countChar(normalized, ')');
  if (unbalancedQuotes || unbalancedParens) {
    return true;
  }

  const endsWithStrongPunctuation = /[.!?…)]$/.test(normalized);
  const endsWithHashtag = /#[\p{L}\p{N}_]+$/u.test(normalized);
  const endsWithMention = /@[\p{L}\p{N}_.]+$/u.test(normalized);
  const endsWithEmoji = /\p{Extended_Pictographic}$/u.test(normalized);

  return !(endsWithStrongPunctuation || endsWithHashtag || endsWithMention || endsWithEmoji);
}

function countChar(text: string, char: string): number {
  return Array.from(text).filter((current) => current === char).length;
}
