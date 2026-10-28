// ============================================================================
// SUPABASE EDGE FUNCTION: gemini-exam
// Ubicación: supabase/functions/gemini-exam/index.ts
// Descripción: Backend seguro para comunicarse con Google Gemini API sin
//              exponer GEMINI_API_KEY en el cliente Angular/Ionic.
//              100% autocontenido (sin dependencias externas) para pegar
//              directamente en el Editor Web de Supabase o desplegar por CLI.
// ============================================================================

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Elimina cualquier encabezado Data URL (ej. "data:audio/webm;codecs=opus;base64,")
 * y espacios en blanco para dejar únicamente los bytes Base64 puros que exige Gemini.
 */
function stripDataUrlPrefix(raw?: string): string {
  if (!raw) {
    return '';
  }
  const trimmed = raw.trim();
  const commaIdx = trimmed.indexOf(',');
  const withoutHeader =
    trimmed.startsWith('data:') && commaIdx !== -1
      ? trimmed.slice(commaIdx + 1)
      : trimmed.replace(/^data:[^,]+,/, '');
  return withoutHeader.replace(/\s+/g, '');
}

interface GenerateQuestionsPayload {
  action: 'generate-questions';
  syllabus: string;
  imageUrl: string;
  imageBase64?: string;
  imageMimeType?: string;
}

interface EvaluateAnswerPayload {
  action: 'evaluate-answer';
  syllabus: string;
  imageUrl: string;
  questions: string[];
  userAnswer?: string;
  imageBase64?: string;
  imageMimeType?: string;
  audioBase64?: string;
  audioMimeType?: string;
}

interface TranscribeAudioPayload {
  action: 'transcribe-audio';
  audioBase64: string;
  audioMimeType?: string;
}

type EdgeRequestPayload =
  | GenerateQuestionsPayload
  | EvaluateAnswerPayload
  | TranscribeAudioPayload;

interface FeedbackErrorItem {
  original: string;
  corrected: string;
  explanation: string;
}

interface FeedbackSuggestionItem {
  advice: string;
  example?: string;
}

interface StructuredFeedbackResponse {
  hasErrors: boolean;
  noErrorsMessage: string;
  errores: FeedbackErrorItem[];
  aciertos: string[];
  sugerencias: FeedbackSuggestionItem[];
  transcript?: string;
  rawMarkdown?: string;
}

/**
 * Convierte la URL de la fotografía a una resolución ligera optimizada para IA (512x384, q=65),
 * reduciendo el peso en un 75% (~25 KB) para que la descarga en el servidor y el análisis visual
 * de Gemini sean mucho más rápidos sin afectar la calidad que ve el usuario en su pantalla.
 */
function toLightweightAiImageUrl(url: string): string {
  try {
    const cleanUrl = url.replace(/[?&]random=\d+/g, '');
    if (cleanUrl.includes('images.unsplash.com')) {
      return cleanUrl
        .replace(/w=\d+/g, 'w=512')
        .replace(/h=\d+/g, 'h=384')
        .replace(/q=\d+/g, 'q=65');
    }
    if (cleanUrl.includes('picsum.photos')) {
      return cleanUrl.replace(/\/800\/600/g, '/512/384');
    }
    return cleanUrl;
  } catch {
    return url;
  }
}

/**
 * Descarga la imagen en versión ligera desde imageUrl en caso de que el cliente no envíe imageBase64.
 */
async function resolveImageInlineData(
  imageUrl: string,
  imageBase64?: string,
  imageMimeType?: string,
  timeoutMs = 3500
): Promise<{ data: string; mimeType: string } | null> {
  if (imageBase64 && imageBase64.trim().length > 0) {
    const cleanBase64 = stripDataUrlPrefix(imageBase64);
    return {
      data: cleanBase64,
      mimeType: (imageMimeType || 'image/jpeg').split(';')[0].trim(),
    };
  }

  if (!imageUrl) {
    return null;
  }

  try {
    const fastUrl = toLightweightAiImageUrl(imageUrl);
    const response = await fetch(fastUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();
    const base64Data = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
    return {
      data: base64Data,
      mimeType: contentType.split(';')[0].trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Construye el prompt exacto de la sección 6.3 para generar 5 preguntas + 3 palabras de vocabulario.
 */
function buildQuestionsPrompt(syllabus: string, imageContext: string): string {
  return `Actúa como un profesor de inglés que prepara a un estudiante para un examen oral escolar basado en la descripción de fotografías.

Tu objetivo es generar:
A) Exactamente cinco preguntas sencillas en inglés ("questions") para que el estudiante practique los temas de gramática y vocabulario incluidos en su resumen.
B) Exactamente tres palabras o expresiones cortas de vocabulario ("vocabulary") relacionadas con los elementos, acciones o personas visibles en la fotografía para que el estudiante aprenda vocabulario nuevo y pueda usarlo al describir la escena.

**Instrucciones para las 5 preguntas:**
1. Nivel básico o intermedio, preguntas cortas, claras y naturales al estilo de las tarjetas "TALK ABOUT THE PICTURE" (1. Who are they? Where are they?, 2. Describe the people..., 3. What are they doing?, 4. Advice/rules/directions..., 5. What will happen next?).
2. Basa las preguntas en el resumen del estudiante y en las personas, lugar y acciones reales de la fotografía.
3. No inventes detalles que no estén en la imagen ni exijas estructuras avanzadas.

**Instrucciones para las 3 palabras de vocabulario ("vocabulary"):**
1. Elige 3 palabras o frases útiles en inglés que se relacionen directamente con lo que se ve en la fotografía (objetos, vestimenta, lugar, gestos o acciones de las personas) y que enriquezcan el vocabulario del estudiante.
2. Para cada palabra incluye:
   - "word": la palabra o expresión en inglés (ej. "Point out", "Crossroads", "Clipboard").
   - "meaning": traducción breve y clara al español (ej. "señalar / indicar", "cruce de calles", "carpeta sujetapapeles").
   - "example": una oración corta y sencilla en inglés usándola para describir esta foto (ej. "She is pointing out the route on the map.").

**Formato de salida:**
Devuelve exclusivamente un objeto JSON válido con las propiedades "questions" (5 preguntas) y "vocabulary" (3 objetos).

**Resumen de gramática y vocabulario:**
${syllabus}

**Fotografía o contexto visual:**
${imageContext}`;
}

/**
 * Construye el prompt exacto de la sección 7.1 para corregir la respuesta del estudiante.
 */
function buildEvaluationPrompt(
  questions: string[],
  userAnswer: string,
  syllabus: string,
  imageContext: string
): string {
  const formattedQuestions = questions
    .map((q, idx) => `${idx + 1}. ${q}`)
    .join('\n');

  return `Actúa como un profesor de inglés que ayuda a un estudiante a preparar un examen oral escolar mediante la descripción de fotografías.

Tu objetivo es evaluar la respuesta del estudiante de manera clara, amigable y constructiva.

La evaluación debe centrarse en si el estudiante comprende y aplica correctamente la gramática y el vocabulario de su resumen.

**Instrucciones:**

1. Corrige los errores gramaticales importantes de la respuesta.
2. Verifica si el estudiante aplicó correctamente las estructuras y el vocabulario incluidos en el resumen.
3. Ignora los errores menores de ortografía (*typos*), ya que el objetivo es practicar para un examen oral.
4. No penalices las respuestas sencillas si son correctas.
5. No exijas vocabulario avanzado ni estructuras gramaticales que no aparezcan en los apuntes.
6. Comprueba si las respuestas se relacionan con las preguntas y la fotografía.
7. Si una respuesta es correcta, explica brevemente qué hizo bien.
8. Si una respuesta es demasiado breve o incompleta, indica cómo podría ampliarla con una frase sencilla.
9. Si hay errores, proporciona una versión corregida y una explicación breve.
10. Distingue los errores gramaticales reales de las expresiones que son simplemente diferentes, pero igualmente correctas.
11. No inventes errores para completar las secciones.
12. No consideres incorrecta una respuesta solo porque utiliza palabras diferentes de las que esperabas.
13. No penalices al estudiante por no utilizar todas las reglas del resumen si las preguntas no requieren aplicarlas.
14. Utiliza un nivel de inglés apropiado para el estudiante.
15. Escribe la explicación de la retroalimentación en español, pero conserva en inglés las frases originales y sus correcciones.
16. Mantén un tono motivador y constructivo.

**Estructura obligatoria de la respuesta:**

### Errores

Explica los errores gramaticales importantes encontrados.

Para cada error, muestra:

- La frase original.
- La versión corregida.
- Una explicación breve en español.

Si no hay errores importantes, indica que la respuesta no presenta errores gramaticales relevantes.

### Aciertos

Destaca las estructuras gramaticales, el vocabulario y las ideas que el estudiante utilizó correctamente.

Incluye ejemplos concretos de la respuesta cuando sea posible.

### Sugerencias

Proporciona entre dos y tres recomendaciones concretas para mejorar la respuesta.

Las recomendaciones deben ser sencillas, prácticas y relacionadas con los temas del resumen.

Cuando sea útil, incluye un ejemplo de una frase que el estudiante podría utilizar para expresarse mejor.

**Preguntas realizadas:**

${formattedQuestions}

**Respuesta del estudiante:**

${userAnswer}

**Resumen de gramática y vocabulario:**

${syllabus}

**Contexto de la fotografía:**

${imageContext}

**Importante:** no evalúes la complejidad de la respuesta. Evalúa si el estudiante responde adecuadamente, utiliza correctamente la gramática estudiada y logra comunicar sus ideas.

Devuelve tu evaluación en formato JSON estructurado con las propiedades:
- "hasErrors": booleano que indica si hubo errores gramaticales importantes.
- "noErrorsMessage": mensaje motivador en español cuando no hay errores importantes (por ejemplo: "¡Excelente trabajo! Tu respuesta no presenta errores gramaticales relevantes.").
- "errores": lista de objetos con { "original": "frase en inglés", "corrected": "versión corregida en inglés", "explanation": "explicación breve en español" }.
- "aciertos": lista de textos en español (conservando las citas o ejemplos en inglés) destacando lo que hizo bien.
- "sugerencias": lista de entre 2 y 3 objetos con { "advice": "recomendación en español", "example": "ejemplo opcional de frase en inglés" }.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Obtiene dinámicamente la lista de modelos disponibles en la cuenta si los principales
 * están saturados (HTTP 503) o cambiaron de nombre.
 */
async function fetchAvailableFlashModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as {
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    };
    if (!Array.isArray(data.models)) {
      return [];
    }

    return data.models
      .filter(
        (m) =>
          m.name &&
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          (m.name.includes('gemini') || m.name.includes('flash')) &&
          !m.name.includes('embedding') &&
          !m.name.includes('imagen') &&
          !m.name.includes('image') &&
          !m.name.includes('tts') &&
          !m.name.includes('computer-use') &&
          !m.name.includes('robotics') &&
          !m.name.includes('aqa') &&
          !m.name.includes('veo')
      )
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort((a, b) => {
        const aFlash = a.includes('flash') ? 0 : 1;
        const bFlash = b.includes('flash') ? 0 : 1;
        return aFlash - bFlash;
      });
  } catch {
    return [];
  }
}

/**
 * Invoca la API de Gemini desactivando el razonamiento oculto (thinkingBudget: 0) en los modelos
 * Flash para reducir la latencia a la mitad, y cambiando de inmediato al modelo ligero si hay
 * alta demanda (HTTP 503) sin esperas innecesarias.
 */
async function callGeminiWithFallback(
  apiKey: string,
  parts: Array<Record<string, unknown>>,
  responseSchema: Record<string, unknown>
): Promise<{ text: string; modelUsed: string }> {
  const preferredModel = Deno.env.get('GEMINI_MODEL')?.trim() || 'gemini-3.8-flash';
  const candidateModels = Array.from(
    new Set([
      preferredModel,
      'gemini-3.8-flash',
      'gemini-3.8-flash-lite',
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
    ])
  );

  let lastErrorText = '';
  let dynamicModelsLoaded = false;

  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const generationConfig: Record<string, unknown> = {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema,
    };

    // Desactiva el "thinking" interno en los modelos Flash para responder mucho más rápido
    if (model.includes('flash')) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        generationConfig,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text: string | undefined =
        data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.trim().length > 0) {
        return { text, modelUsed: model };
      }
      lastErrorText = 'La respuesta de Gemini llegó vacía.';
      continue;
    }

    const errorBody = await response.text();
    lastErrorText = `Modelo ${model} devolvió HTTP ${response.status}: ${errorBody}`;

    // Si Google sugiere un modelo nuevo en el mensaje, lo agregamos a la lista
    const suggestedMatch = errorBody.match(/models\/([a-zA-Z0-9._-]+)/);
    if (suggestedMatch?.[1] && !candidateModels.includes(suggestedMatch[1])) {
      candidateModels.push(suggestedMatch[1]);
    }

    // Si el error es 401/403 (clave inválida) o un error de Base64 mal formado, detenemos de inmediato
    if (
      response.status === 401 ||
      response.status === 403 ||
      errorBody.includes('Base64 decoding failed')
    ) {
      throw new Error(lastErrorText);
    }

    // Si llegamos al final de la lista inicial y aún no cargamos los modelos dinámicos de la cuenta, los consultamos
    if (i === candidateModels.length - 1 && !dynamicModelsLoaded) {
      dynamicModelsLoaded = true;
      const available = await fetchAvailableFlashModels(apiKey);
      for (const dynModel of available) {
        if (!candidateModels.includes(dynModel)) {
          candidateModels.push(dynModel);
        }
      }
    }
  }

  throw new Error(lastErrorText || 'No se pudo obtener respuesta de la API de Gemini.');
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Método no permitido. Utiliza POST.' }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey || apiKey === 'REEMPLAZAR_POR_UNA_CLAVE_SEGURA') {
      return new Response(
        JSON.stringify({
          error:
            'El secreto GEMINI_API_KEY no está configurado en Supabase Edge Functions.',
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const body = (await req.json()) as EdgeRequestPayload;

    if (!body || !body.action) {
      return new Response(
        JSON.stringify({ error: 'Falta el parámetro "action" en la solicitud.' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Acción para transcribir respuesta oral hablada desde el celular/navegador
    if (body.action === 'transcribe-audio') {
      const cleanAudioBase64 = stripDataUrlPrefix(body.audioBase64);
      if (!cleanAudioBase64) {
        return new Response(
          JSON.stringify({ error: 'No se recibió audio para transcribir.' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      const audioMimeType = (body.audioMimeType || 'audio/webm').split(';')[0].trim();

      const transcriptionPrompt = `You are transcribing an English student's spoken oral exam practice.
Listen carefully to the audio and transcribe into English text EXACTLY what the student said.

IMPORTANT RULES:
1. Preserve the student's exact words and grammatical structures (even if they made a grammar mistake like "he go" or "she have"), because a teacher will evaluate their grammar next.
2. Add normal punctuation (periods, commas, question marks) so it is readable.
3. If the audio is silent or unintelligible, return an empty string in "transcript".
4. Return ONLY a JSON object with the property "transcript".`;

      const transcriptionSchema = {
        type: 'OBJECT',
        properties: {
          transcript: { type: 'STRING' },
        },
        required: ['transcript'],
      };

      const { text, modelUsed } = await callGeminiWithFallback(
        apiKey,
        [
          { text: transcriptionPrompt },
          {
            inlineData: {
              mimeType: audioMimeType,
              data: cleanAudioBase64,
            },
          },
        ],
        transcriptionSchema
      );

      const parsed = JSON.parse(text) as { transcript?: string };
      return new Response(
        JSON.stringify({
          transcript: (parsed.transcript || '').trim(),
          modelUsed,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const syllabus = (body.syllabus || '').trim();
    if (!syllabus) {
      return new Response(
        JSON.stringify({
          error: 'El resumen de inglés (syllabus) está vacío.',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const inlineImage = await resolveImageInlineData(
      body.imageUrl,
      body.imageBase64,
      body.imageMimeType,
      body.action === 'evaluate-answer' ? 2000 : 3500
    );

    const imageContext = inlineImage
      ? `Fotografía adjunta como imagen en esta solicitud (URL de referencia: ${body.imageUrl}). Analiza visualmente las personas, objetos, lugar y acciones presentes en la imagen.`
      : `Fotografía de situación cotidiana para práctica oral (URL: ${body.imageUrl}).`;

    if (body.action === 'generate-questions') {
      const prompt = buildQuestionsPrompt(syllabus, imageContext);
      const parts: Array<Record<string, unknown>> = [{ text: prompt }];

      if (inlineImage) {
        parts.push({
          inlineData: {
            mimeType: inlineImage.mimeType,
            data: inlineImage.data,
          },
        });
      }

      const questionsSchema = {
        type: 'OBJECT',
        properties: {
          questions: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
          vocabulary: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                word: { type: 'STRING' },
                meaning: { type: 'STRING' },
                example: { type: 'STRING' },
              },
              required: ['word', 'meaning', 'example'],
            },
          },
        },
        required: ['questions', 'vocabulary'],
      };

      const { text, modelUsed } = await callGeminiWithFallback(
        apiKey,
        parts,
        questionsSchema
      );

      const parsed = JSON.parse(text) as {
        questions?: unknown;
        vocabulary?: Array<{ word?: string; meaning?: string; example?: string }>;
      };
      const rawQuestions = Array.isArray(parsed.questions)
        ? parsed.questions
            .map((item) => String(item).trim())
            .filter((item) => item.length > 0)
        : [];

      if (rawQuestions.length === 0) {
        throw new Error('Gemini no devolvió preguntas válidas.');
      }

      const normalizedQuestions = rawQuestions.slice(0, 5);
      while (normalizedQuestions.length < 5) {
        normalizedQuestions.push(
          `Question ${normalizedQuestions.length + 1}: What else can you describe about this picture using your notes?`
        );
      }

      const normalizedVocabulary = Array.isArray(parsed.vocabulary)
        ? parsed.vocabulary
            .filter((v) => v && v.word && v.meaning)
            .map((v) => ({
              word: String(v.word).trim(),
              meaning: String(v.meaning).trim(),
              example: String(v.example || '').trim(),
            }))
            .slice(0, 3)
        : [];

      return new Response(
        JSON.stringify({
          questions: normalizedQuestions,
          vocabulary: normalizedVocabulary,
          modelUsed,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (body.action === 'evaluate-answer') {
      const questions = Array.isArray(body.questions) ? body.questions : [];
      const userAnswer = (body.userAnswer || '').trim();
      const cleanAudioBase64 = stripDataUrlPrefix(body.audioBase64);
      const hasAudio = cleanAudioBase64.length > 0;

      if (!userAnswer && !hasAudio) {
        return new Response(
          JSON.stringify({ error: 'La respuesta del estudiante está vacía.' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      const answerContextText = hasAudio
        ? userAnswer
          ? `${userAnswer}\n(Además, el estudiante adjuntó su respuesta oral en el archivo de audio incluido en esta solicitud. Escucha el audio, transcríbelo fielmente en la propiedad "transcript" y evalúa tanto lo hablado como lo escrito).`
          : `(El estudiante respondió de forma oral mediante el archivo de audio adjunto en esta solicitud. Primero transcribe exactamente lo que dijo en inglés dentro de la propiedad "transcript" sin autocorregir su gramática, y luego evalúa su respuesta oral siguiendo todas las instrucciones).`
        : userAnswer;

      const prompt = buildEvaluationPrompt(
        questions,
        answerContextText,
        syllabus,
        imageContext
      );

      const parts: Array<Record<string, unknown>> = [{ text: prompt }];
      if (inlineImage) {
        parts.push({
          inlineData: {
            mimeType: inlineImage.mimeType,
            data: inlineImage.data,
          },
        });
      }

      if (hasAudio) {
        const rawAudioMime = (body.audioMimeType || 'audio/mp4').split(';')[0].trim();
        parts.push({
          inlineData: {
            mimeType: rawAudioMime || 'audio/mp4',
            data: cleanAudioBase64,
          },
        });
      }

      const schemaProperties: Record<string, unknown> = {
        hasErrors: { type: 'BOOLEAN' },
        noErrorsMessage: { type: 'STRING' },
        errores: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              original: { type: 'STRING' },
              corrected: { type: 'STRING' },
              explanation: { type: 'STRING' },
            },
            required: ['original', 'corrected', 'explanation'],
          },
        },
        aciertos: {
          type: 'ARRAY',
          items: { type: 'STRING' },
        },
        sugerencias: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              advice: { type: 'STRING' },
              example: { type: 'STRING' },
            },
            required: ['advice'],
          },
        },
      };

      const requiredFields = [
        'hasErrors',
        'noErrorsMessage',
        'errores',
        'aciertos',
        'sugerencias',
      ];

      // Solo pedimos "transcript" cuando el estudiante envió audio, ahorrando tokens y tiempo en respuestas escritas
      if (hasAudio) {
        schemaProperties.transcript = { type: 'STRING' };
        requiredFields.unshift('transcript');
      }

      const evaluationSchema = {
        type: 'OBJECT',
        properties: schemaProperties,
        required: requiredFields,
      };

      const { text, modelUsed } = await callGeminiWithFallback(
        apiKey,
        parts,
        evaluationSchema
      );

      const parsed = JSON.parse(text) as StructuredFeedbackResponse;

      // Construir también una versión Markdown estructurada con las 3 secciones obligatorias
      const erroresSection =
        parsed.errores && parsed.errores.length > 0
          ? parsed.errores
              .map(
                (err) =>
                  `- **Original:** "${err.original}"\n  **Corrección:** "${err.corrected}"\n  **Explicación:** ${err.explanation}`
              )
              .join('\n')
          : parsed.noErrorsMessage ||
            'La respuesta no presenta errores gramaticales relevantes.';

      const aciertosSection =
        parsed.aciertos && parsed.aciertos.length > 0
          ? parsed.aciertos.map((acierto) => `- ${acierto}`).join('\n')
          : '- Lograste comunicar tus ideas principales en inglés en relación con las preguntas.';

      const sugerenciasSection =
        parsed.sugerencias && parsed.sugerencias.length > 0
          ? parsed.sugerencias
              .map((sug) =>
                sug.example
                  ? `- ${sug.advice} Ejemplo: *"${sug.example}"*`
                  : `- ${sug.advice}`
              )
              .join('\n')
          : '- Continúa practicando con oraciones completas aplicando los temas de tu resumen.';

      const rawMarkdown = `### Errores\n\n${erroresSection}\n\n### Aciertos\n\n${aciertosSection}\n\n### Sugerencias\n\n${sugerenciasSection}`;

      const feedbackResponse: StructuredFeedbackResponse = {
        hasErrors: Boolean(parsed.hasErrors && parsed.errores?.length > 0),
        noErrorsMessage:
          parsed.noErrorsMessage ||
          'La respuesta no presenta errores gramaticales relevantes.',
        errores: Array.isArray(parsed.errores) ? parsed.errores : [],
        aciertos: Array.isArray(parsed.aciertos) ? parsed.aciertos : [],
        sugerencias: Array.isArray(parsed.sugerencias) ? parsed.sugerencias : [],
        transcript: (parsed.transcript || userAnswer || '').trim(),
        rawMarkdown,
      };

      return new Response(
        JSON.stringify({
          feedback: feedbackResponse,
          modelUsed,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Acción no reconocida.' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Error interno al procesar la solicitud con Gemini.';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
