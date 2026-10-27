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
 * Descarga la imagen desde imageUrl en caso de que el cliente no haya enviado imageBase64.
 */
async function resolveImageInlineData(
  imageUrl: string,
  imageBase64?: string,
  imageMimeType?: string
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
    const response = await fetch(imageUrl);
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
 * Construye el prompt exacto de la sección 6.3 para generar 5 preguntas.
 */
function buildQuestionsPrompt(syllabus: string, imageContext: string): string {
  return `Actúa como un profesor de inglés que prepara a un estudiante para un examen oral escolar basado en la descripción de fotografías.

Tu objetivo es generar exactamente cinco preguntas sencillas en inglés para que el estudiante practique los temas de gramática y vocabulario incluidos en su resumen.

**Contexto del estudiante:**

El estudiante está practicando los contenidos de sus apuntes. Las preguntas deben servir para demostrar que sabe aplicar esos temas en situaciones cotidianas.

**Instrucciones para generar las preguntas:**

1. Utiliza un nivel de inglés básico o intermedio, con preguntas cortas, claras y naturales.
2. Basa las preguntas principalmente en el vocabulario y las estructuras gramaticales que aparecen en el resumen.
3. Ten en cuenta la fotografía proporcionada. Las preguntas deben relacionarse con las personas, los objetos, el lugar o las acciones que aparecen en ella.
4. Prioriza preguntas típicas de un examen oral de descripción de imágenes.
5. Puedes preguntar quiénes aparecen en la imagen, dónde están, cómo son físicamente, qué están haciendo, qué sucede en la escena o qué podrían hacer después.
6. Si el resumen incluye temas como \`Appearance\`, \`Directions\`, \`Present Continuous\`, \`Simple Present\`, \`Past Simple\`, \`Future\`, \`Comparatives\`, \`Prepositions of Place\` o vocabulario similar, utilízalos cuando sean relevantes para la imagen.
7. No es obligatorio utilizar todos los temas en una misma práctica. Selecciona únicamente los que se puedan practicar de forma natural.
8. Formula preguntas abiertas que permitan responder con una o varias oraciones en inglés.
9. Evita preguntas demasiado complejas, abstractas, técnicas o hipotéticas.
10. No exijas respuestas largas ni estructuras gramaticales avanzadas.
11. No inventes detalles que no se puedan deducir razonablemente de la fotografía.
12. No incluyas preguntas que requieran conocimientos externos a la imagen o al resumen.
13. Mantén un estilo parecido al de las preguntas orientativas de un examen oral escolar: directo, cotidiano y fácil de comprender.
14. Si una pregunta no permite practicar razonablemente los temas del resumen, reemplázala por otra más adecuada.
15. Distribuye las preguntas entre distintos aspectos de la imagen, evitando repetir la misma idea.

**Ejemplo del estilo esperado (tarjetas de examen oral "TALK ABOUT THE PICTURE"):**

Ejemplo A (dos personas en la calle con un mapa):
1. Who are they? Where are they?
2. Describe the two people in the picture (hair, height, etc.).
3. What are they doing? Why did the tourist stop the other person?
4. What advice or directions should the local person give to the tourist?
5. What will the tourist do next?

Ejemplo B (una enfermera/médica atendiendo a una paciente):
1. Who is she? Where is she?
2. How is she feeling?
3. What has happened to her?
4. What should / shouldn't she do?
5. What will she do next?

Ejemplo C (estudiantes y profesor en un aula):
1. Who are they? Where are they?
2. Describe the people in the picture. How are they feeling?
3. What are they doing?
4. What rules are there in this place?
5. What will happen next?

Estos ejemplos definen el estilo y el nivel de dificultad esperados. No debes repetir siempre las mismas preguntas: adáptalas a la escena real de la fotografía y al resumen proporcionado.

**Formato de salida:**

Devuelve exclusivamente un objeto JSON válido con la propiedad "questions" que contenga exactamente cinco preguntas en inglés.
No incluyas introducciones, respuestas modelo, traducciones, explicaciones gramaticales, comentarios sobre la imagen ni conclusiones.

Estructura JSON requerida:
{
  "questions": [
    "Who are they? Where are they?",
    "Describe the people in the picture.",
    "What are they doing?",
    "What is happening in the picture?",
    "What do you think they will do next?"
  ]
}

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
 * Invoca la API de Gemini intentando primero `gemini-3.8-flash`, con reintentos automáticos
 * ante picos de demanda (HTTP 503) y fallback automático a modelos alternativos disponibles
 * en la cuenta.
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
      'gemini-3.8-pro',
    ])
  );

  let lastErrorText = '';
  let dynamicModelsLoaded = false;

  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    // Hasta 2 intentos por modelo si Google responde 503 (alta demanda temporal)
    for (let attempt = 1; attempt <= 2; attempt++) {
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
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
            responseSchema,
          },
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
        break;
      }

      const errorBody = await response.text();
      lastErrorText = `Modelo ${model} devolvió HTTP ${response.status}: ${errorBody}`;

      // Si es 503 (alta demanda temporal) en el primer intento, esperamos 1.2s y reintentamos este mismo modelo
      if (response.status === 503 && attempt === 1) {
        await delay(1200);
        continue;
      }

      // Si Google sugiere un modelo nuevo en el mensaje, lo agregamos a la lista
      const suggestedMatch = errorBody.match(/models\/([a-zA-Z0-9._-]+)/);
      if (suggestedMatch?.[1] && !candidateModels.includes(suggestedMatch[1])) {
        candidateModels.push(suggestedMatch[1]);
      }

      // Si el error es 401/403 (clave inválida), no tiene sentido probar otros modelos
      if (response.status === 401 || response.status === 403) {
        throw new Error(lastErrorText);
      }

      break;
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
      body.imageMimeType
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
        },
        required: ['questions'],
      };

      const { text, modelUsed } = await callGeminiWithFallback(
        apiKey,
        parts,
        questionsSchema
      );

      const parsed = JSON.parse(text) as { questions?: unknown };
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

      return new Response(
        JSON.stringify({
          questions: normalizedQuestions,
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

      const evaluationSchema = {
        type: 'OBJECT',
        properties: {
          transcript: { type: 'STRING' },
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
        },
        required: [
          'transcript',
          'hasErrors',
          'noErrorsMessage',
          'errores',
          'aciertos',
          'sugerencias',
        ],
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
