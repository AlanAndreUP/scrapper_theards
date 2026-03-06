import axios, { AxiosError, type AxiosInstance } from "axios";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";

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

  constructor(
    private readonly config: GeminiConfig,
    private readonly logger: Logger
  ) {
    this.http = axios.create({
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      timeout: config.timeoutMs,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  async generateViralCopy(captionOriginal: string, permalink: string): Promise<string> {
    const maxChars = 5000;
    const toneInstruction = buildToneInstructions(captionOriginal);

    const basePrompt = [
      "Eres un redactor experto en contenido viral de fútbol para Facebook, especializado en Liga MX, selección mexicana, fichajes, rumores, polémicas, declaraciones, goles y noticias de alto engagement.",
      `Genera un copy en español, listo para publicar en Facebook, con un máximo de ${maxChars} caracteres.`,

      "OBJETIVO:",
      "Escribir un texto que atrape desde la primera línea, informe con claridad y provoque reacciones, comentarios o compartidos.",

      "ESTILO:",
      "- Futbolero, directo, emocional y natural.",
      "- Ritmo dinámico, fácil de leer en móvil.",
      "- Debe sentirse como una página deportiva con personalidad, no como un comunicado.",
      "- Puede ser intenso o debatible si el tema lo permite, pero sin mentir ni exagerar hechos no confirmados.",
      "- Evita tono corporativo, genérico o aburrido.",

      "ESTRUCTURA:",
      "- Primera línea con hook fuerte.",
      "- Desarrollo con contexto claro y útil.",
      "- Resalta por qué importa la noticia, rumor, polémica o declaración.",
      "- Cierre con una pregunta, opinión, reacción o llamado a comentar.",
      "- Puedes incluir entre 3 y 6 hashtags si realmente aportan.",

      "REGLAS IMPORTANTES:",
      "- No inventes datos, resultados, declaraciones, lesiones, sanciones ni fichajes.",
      "- Si el caption trae poca información, trabaja solo con lo disponible y mantén el copy atractivo sin fabricar hechos.",
      "- Si es rumor, interés o reporte, debe quedar claro que no es oficial.",
      "- Si es oficial, transmítelo con contundencia.",
      "- No expliques el proceso.",
      '- No pongas textos como "Aquí tienes el copy" o "Texto sugerido".',
      "- No repitas ideas.",
      "- No abuses de emojis; usa pocos y solo si elevan el impacto.",
      "- El texto debe terminar completo, sin frases truncadas.",

      "ENFOQUE ESPECIAL:",
      toneInstruction,

      `Caption original: ${captionOriginal || "(sin caption)"}`,
      `Fuente: ${permalink}`,

      "Devuelve únicamente el texto final."
    ].join("\n");

    const firstAttempt = await this.generateCopyAttempt({
      prompt: basePrompt,
      maxOutputTokens: 700,
      temperature: 0.75
    });

    let selected = firstAttempt;

    if (isMaxTokensFinish(firstAttempt.finishReason)) {
      this.logger.warn("Gemini copy came back with MAX_TOKENS, retrying with larger output budget", {
        model: this.config.textModel,
        firstLength: firstAttempt.text.length
      });

      const secondAttempt = await this.generateCopyAttempt({
        prompt: [
          basePrompt,
          "Asegúrate de que el texto tenga cierre fuerte, natural y completo.",
          "No cortes ideas a la mitad."
        ].join("\n"),
        maxOutputTokens: 1100,
        temperature: 0.7
      });

      if (
        secondAttempt.text &&
        (!isMaxTokensFinish(secondAttempt.finishReason) ||
          secondAttempt.text.length >= firstAttempt.text.length)
      ) {
        selected = secondAttempt;
      }
    }

    let text = normalizeGeneratedCopy(selected.text);

    if (looksLikeTruncatedCopy(text)) {
      this.logger.warn("Gemini copy seems truncated by heuristic; requesting rewrite", {
        model: this.config.textModel,
        length: text.length,
        finishReason: selected.finishReason ?? "unknown",
        ending: text.slice(-24)
      });

      const repairPrompt = [
        "Reescribe y completa este copy de fútbol para Facebook.",
        `Máximo ${maxChars} caracteres.`,
        "Debe quedar viral, claro, natural y totalmente cerrado.",
        "Incluye hook fuerte, desarrollo con contexto y cierre que invite a comentar.",
        "No inventes datos.",
        "Si el tema es rumor, déjalo claro como rumor o reporte.",
        "Devuelve únicamente el texto final.",
        `Borrador truncado o incompleto: ${text}`,
        `Caption original: ${captionOriginal || "(sin caption)"}`,
        `Fuente: ${permalink}`
      ].join("\n");

      const repaired = await this.generateCopyAttempt({
        prompt: repairPrompt,
        maxOutputTokens: 1100,
        temperature: 0.65
      });

      if (repaired.text) {
        text = normalizeGeneratedCopy(repaired.text);
        selected = repaired;
      }
    }

    text = fitMaxLengthWithoutBreakingWords(text, maxChars);

    if (!text) {
      throw new ExternalServiceError("Gemini no devolvió texto para el copy viral.");
    }

    this.logger.info("Gemini copy generated", {
      model: this.config.textModel,
      length: text.length,
      finishReason: selected.finishReason ?? "unknown"
    });

    return text;
  }

  async generateViralImage(inputImageBuffer: Buffer, captionOriginal: string): Promise<Buffer> {
    const inputMimeType = detectImageMimeType(inputImageBuffer);

    const prompt = [
      "Edita o genera una imagen para Facebook con estilo NOTICIA DEPORTIVA editorial, no meme.",
      "Debe conservar la esencia del sujeto original con enfoque fotorealista y periodístico.",
      "Look & feel: cobertura deportiva profesional, composición limpia, color grading natural, nitidez alta.",
      "Prohibido: estilo meme, stickers, globos de diálogo, tipografía caricaturesca, chistes visuales, emojis grandes.",
      "No deformes rostros ni cuerpos; evita estética de caricatura o collage.",
      "Si incluyes texto, que sea solo un titular breve estilo noticiero deportivo, sobrio y legible.",
      'Si la imagen original contiene logo, marca de agua o texto de "Somos Titanes", elimínalo completamente del resultado final.',
      "Evita marcas registradas, escudos alterados y elementos inventados.",
      `Contexto del caption original: ${captionOriginal || "(sin caption)"}`,
      "Devuelve la mejor imagen final en formato JPG o PNG."
    ].join("\n");

    const response = await this.generateContent(this.config.imageModel, {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: inputMimeType,
                data: inputImageBuffer.toString("base64")
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        temperature: 0.45
      }
    });

    const imageBuffer = extractImageFromGemini(response);
    if (!imageBuffer) {
      throw new ExternalServiceError(
        "Gemini no devolvió imagen binaria. Valida el modelo configurado en GEMINI_MODEL_IMAGE y sus capacidades de image generation."
      );
    }

    this.logger.info("Gemini image generated", {
      model: this.config.imageModel,
      outputBytes: imageBuffer.length
    });

    return imageBuffer;
  }

  private async generateCopyAttempt(attempt: CopyGenerationAttempt): Promise<ExtractedGeminiText> {
    const response = await this.generateContent(this.config.textModel, {
      contents: [
        {
          role: "user",
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

  private async generateContent(
    model: string,
    body: Record<string, unknown>
  ): Promise<GeminiGenerateResponse> {
    try {
      const response = await this.http.post<GeminiGenerateResponse>(
        `/models/${model}:generateContent`,
        body,
        {
          params: {
            key: this.config.apiKey
          }
        }
      );

      return response.data;
    } catch (error) {
      const details = normalizeAxiosError(error);
      throw new ExternalServiceError(`Gemini API error (${details})`, { cause: error });
    }
  }
}

function extractTextFromGemini(response: GeminiGenerateResponse): ExtractedGeminiText {
  const candidates = response.candidates ?? [];
  let fallback: ExtractedGeminiText = { text: "" };

  for (const candidate of candidates) {
    const text = (candidate.content?.parts ?? [])
      .map((part) => part.text?.trim())
      .filter((value): value is string => Boolean(value))
      .join("\n")
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
    .join("\n")
    .trim();

  return {
    text: legacyText ?? ""
  };
}

function extractImageFromGemini(response: GeminiGenerateResponse): Buffer | null {
  const parts = response.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    const data = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType ?? "";

    if (data && mimeType.startsWith("image/")) {
      return Buffer.from(data, "base64");
    }
  }

  const generatedImageBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (generatedImageBytes) {
    return Buffer.from(generatedImageBytes, "base64");
  }

  return null;
}

function detectImageMimeType(buffer: Buffer): string {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  return "image/jpeg";
}

function normalizeAxiosError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const message = error.message;

    if (status) {
      return `${status} ${statusText ?? ""} ${message}`.trim();
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
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/```$/g, "")
    .replace(/\r/g, "")
    .trim();

  return compact.replace(/\n{3,}/g, "\n\n");
}

function isMaxTokensFinish(finishReason: string | undefined): boolean {
  return (finishReason ?? "").toUpperCase() === "MAX_TOKENS";
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
  const lastSpace = hardCut.lastIndexOf(" ");

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
    "y",
    "o",
    "si",
    "que",
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "un",
    "una",
    "para",
    "con",
    "por",
    "en",
    "al",
    "a",
    "ya",
    "pero"
  ]);

  const lastWord = lower.split(/\s+/).filter(Boolean).at(-1) ?? "";
  if (danglingEndings.has(lastWord)) {
    return true;
  }

  const unbalancedQuotes = (normalized.match(/"/g)?.length ?? 0) % 2 !== 0;
  const unbalancedParens = countChar(normalized, "(") !== countChar(normalized, ")");

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

function buildToneInstructions(captionOriginal: string): string {
  const text = (captionOriginal || "").toLowerCase();

  if (!text.trim()) {
    return [
      "Usa un tono futbolero, viral e informativo.",
      "Como no hay caption útil, evita inventar hechos concretos.",
      "Enfócate en generar curiosidad, reacción y conversación sin afirmar datos no confirmados."
    ].join(" ");
  }

  if (
    includesAny(text, [
      "oficial",
      "confirmado",
      "es nuevo",
      "ya es nuevo",
      "anunció",
      "anunciado",
      "presentado"
    ])
  ) {
    return [
      "Transmite certeza, impacto y sensación de noticia importante confirmada.",
      "Haz que se sienta como un movimiento fuerte o una noticia relevante para la afición."
    ].join(" ");
  }

  if (
    includesAny(text, [
      "podría",
      "interesa",
      "interesado",
      "evaluando",
      "suena",
      "buscaría",
      "estaría",
      "en la mira",
      "en el radar",
      "negociación",
      "negociaciones",
      "analiza",
      "analizando",
      "reportes",
      "según"
    ])
  ) {
    return [
      "Trátalo como rumor, interés o reporte.",
      "Genera expectativa y debate, pero sin presentarlo como hecho confirmado.",
      "Debe quedar claro que la información depende de reportes o versiones."
    ].join(" ");
  }

  if (
    includesAny(text, [
      "polémica",
      "escándalo",
      "reglamento",
      "anular",
      "robo",
      "castigo",
      "sanción",
      "violación",
      "irregularidad"
    ])
  ) {
    return [
      "Eleva la tensión y el debate.",
      "Haz sentir que el tema puede explotar en redes o dividir opiniones, sin afirmar especulación como verdad confirmada."
    ].join(" ");
  }

  if (
    includesAny(text, [
      "gol",
      "doblete",
      "hat-trick",
      "asistencia",
      "remontada",
      "final",
      "campeón",
      "lider de goleo",
      "líder de goleo",
      "anotó",
      "marcó"
    ])
  ) {
    return [
      "Hazlo emocionante, explosivo y celebratorio.",
      "El copy debe transmitir grandeza del momento y ganas de reaccionar o compartir."
    ].join(" ");
  }

  if (
    includesAny(text, [
      "lesión",
      "lesionado",
      "rodilla",
      "baja",
      "fuera",
      "operación",
      "operado"
    ])
  ) {
    return [
      "Usa un tono serio, emotivo y empático.",
      "Busca reacción de apoyo, preocupación u opinión, sin caer en dramatismo falso."
    ].join(" ");
  }

  if (
    includesAny(text, [
      "declaró",
      "declaración",
      "dijo",
      "respondió",
      "habló",
      "entrevista"
    ])
  ) {
    return [
      "Haz que la declaración se sienta relevante y debatible.",
      "Enfoca el copy en la reacción que puede generar entre aficionados y medios."
    ].join(" ");
  }

  return [
    "Mantén un tono futbolero, viral, atractivo e informativo.",
    "Debe sentirse natural, con potencial de conversación y compartidos."
  ].join(" ");
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}