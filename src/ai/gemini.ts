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
  candidates?: {
    content?: {
      parts?: GeminiContentPart[];
    };
  }[];
  generatedImages?: {
    image?: {
      mimeType?: string;
      imageBytes?: string;
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
    const prompt = [
      'Eres un copywriter experto en futbol y memes para redes sociales.',
      'Genera un caption viral en español para Facebook (máx 280 caracteres).',
      'Reglas: tono picante pero no ofensivo, CTA corto, 3-5 hashtags relevantes, sin inventar resultados deportivos.',
      `Caption original: ${captionOriginal || '(sin caption)'}`,
      `Fuente: ${permalink}`,
      'Entrega solo el texto final del caption.'
    ].join('\n');

    const response = await this.generateContent(this.config.textModel, {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens: 220
      }
    });

    const text = extractTextFromGemini(response);
    if (!text) {
      throw new ExternalServiceError('Gemini no devolvió texto para el copy viral.');
    }

    return text;
  }

  async generateViralImage(inputImageBuffer: Buffer, captionOriginal: string): Promise<Buffer> {
    const inputMimeType = detectImageMimeType(inputImageBuffer);

    const prompt = [
      'Edita/genera una imagen viral en estilo futbol-meme para Facebook.',
      'Debe conservar la esencia del sujeto original, aumentar impacto visual, contraste alto, texto meme corto en español.',
      'Si la imagen original contiene el logo, marca de agua o texto de "Somos Titanes", elimínalo completamente del resultado final.',
      'Evita marcas registradas y rostros deformados.',
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
        temperature: 0.8
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

function extractTextFromGemini(response: GeminiGenerateResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => part.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .trim();

  return text;
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
