import { Injectable, inject, signal, computed } from '@angular/core';
import { Platform } from '@ionic/angular/standalone';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import {
  ActivePracticeSession,
  AiFeedback,
  AuthUserState,
  EvaluateAnswerResponse,
  FeedbackErrorItem,
  FeedbackSuggestionItem,
  GenerateQuestionsResponse,
  PracticeInsertPayload,
  PracticeRecord,
  SyllabusRecord,
  SyllabusUpsertPayload,
  TranscribeAudioResponse,
} from '../models/photo-exam.models';

@Injectable({
  providedIn: 'root',
})
export class PhotoExamService {
  private readonly platform = inject(Platform);
  private readonly supabase: SupabaseClient;
  private lastRandomSeed = 0;
  private authInitPromise: Promise<AuthUserState | null> | null = null;

  // Estado reactivo compartido entre las páginas Syllabus, Practice y Feedback
  private readonly authUserSignal = signal<AuthUserState | null>(null);
  private readonly syllabusSignal = signal<SyllabusRecord | null>(null);
  private readonly activeSessionSignal = signal<ActivePracticeSession | null>(null);
  private readonly practiceHistorySignal = signal<PracticeRecord[]>([]);

  public readonly currentUser = this.authUserSignal.asReadonly();
  public readonly currentSyllabus = this.syllabusSignal.asReadonly();
  public readonly activeSession = this.activeSessionSignal.asReadonly();
  public readonly practiceHistory = this.practiceHistorySignal.asReadonly();
  public readonly isAuthenticated = computed(() => this.authUserSignal() !== null);

  constructor() {
    this.supabase = createClient(
      environment.supabaseUrl,
      environment.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }
    );

    this.supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user && session.access_token) {
        this.authUserSignal.set(this.mapSupabaseUser(session.user));
      } else {
        this.authUserSignal.set(null);
      }
    });
  }

  // ============================================================================
  // AUTENTICACIÓN Y SESIÓN DE USUARIO (RLS)
  // ============================================================================

  /**
   * Garantiza que exista una sesión autenticada válida (con access_token activo)
   * en Supabase para cumplir con RLS.
   */
  public async ensureAuthenticatedUser(): Promise<AuthUserState | null> {
    if (this.authInitPromise) {
      return this.authInitPromise;
    }

    this.authInitPromise = (async () => {
      try {
        const { data: sessionData, error: sessionError } =
          await this.supabase.auth.getSession();

        if (
          !sessionError &&
          sessionData.session?.user &&
          sessionData.session.access_token
        ) {
          const mapped = this.mapSupabaseUser(sessionData.session.user);
          this.authUserSignal.set(mapped);
          return mapped;
        }

        // Si no hay access_token válido, limpiamos el estado local
        this.authUserSignal.set(null);

        // Intentar autenticación anónima de Supabase si está habilitada en el proyecto
        const { data: anonData, error: anonError } =
          await this.supabase.auth.signInAnonymously();

        if (!anonError && anonData.session?.user && anonData.session.access_token) {
          const mapped = this.mapSupabaseUser(anonData.session.user);
          this.authUserSignal.set(mapped);
          return mapped;
        }

        return null;
      } catch {
        this.authUserSignal.set(null);
        return null;
      } finally {
        this.authInitPromise = null;
      }
    })();

    return this.authInitPromise;
  }

  /**
   * Inicia sesión con correo electrónico y contraseña.
   */
  public async signInWithEmail(email: string, password: string): Promise<AuthUserState> {
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      throw new Error('Ingresa tu correo electrónico y contraseña.');
    }

    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });

    if (error || !data.session?.user) {
      throw new Error(this.translateSupabaseError(error?.message || 'No se pudo iniciar sesión.'));
    }

    const mapped = this.mapSupabaseUser(data.session.user);
    this.authUserSignal.set(mapped);
    return mapped;
  }

  /**
   * Registra un nuevo estudiante con correo electrónico y contraseña.
   * Devuelve `{ user, requiresEmailConfirmation }` según si Supabase exige confirmar el mail.
   */
  public async signUpWithEmail(
    email: string,
    password: string
  ): Promise<{ user: AuthUserState | null; requiresEmailConfirmation: boolean }> {
    const cleanEmail = email.trim();
    if (!cleanEmail || password.length < 6) {
      throw new Error('Ingresa un correo válido y una contraseña de al menos 6 caracteres.');
    }

    const { data, error } = await this.supabase.auth.signUp({
      email: cleanEmail,
      password,
    });

    if (error) {
      throw new Error(this.translateSupabaseError(error.message || 'No se pudo crear la cuenta.'));
    }

    // Si Supabase tiene activada la confirmación por correo, data.session será null hasta que inicie sesión
    if (!data.session || !data.session.access_token) {
      this.authUserSignal.set(null);
      return {
        user: null,
        requiresEmailConfirmation: true,
      };
    }

    const mapped = this.mapSupabaseUser(data.session.user);
    this.authUserSignal.set(mapped);
    return {
      user: mapped,
      requiresEmailConfirmation: false,
    };
  }

  /**
   * Cierra la sesión actual.
   */
  public async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
    this.authUserSignal.set(null);
    this.syllabusSignal.set(null);
    this.activeSessionSignal.set(null);
    this.practiceHistorySignal.set([]);
  }

  private mapSupabaseUser(user: User): AuthUserState {
    return {
      id: user.id,
      email: user.email ?? null,
      isAnonymous: Boolean(user.is_anonymous),
    };
  }

  // ============================================================================
  // OPERACIONES DE RESUMEN (TABLA: syllabus)
  // ============================================================================

  /**
   * Obtiene el resumen de gramática y vocabulario guardado por el estudiante.
   */
  public async getSyllabus(): Promise<SyllabusRecord | null> {
    const user = await this.ensureAuthenticatedUser();
    if (!user) {
      throw new Error(
        'Para consultar o guardar tu resumen necesitas iniciar sesión o habilitar "Anonymous Sign-Ins" en Supabase Auth.'
      );
    }

    const { data, error } = await this.supabase
      .from('syllabus')
      .select('id, content, user_id, created_at, updated_at')
      .eq('user_id', user.id)
      .maybeSingle<SyllabusRecord>();

    if (error) {
      throw new Error(
        this.translateSupabaseError(
          error.message,
          'No se pudo recuperar tu resumen desde Supabase. Verifica tu conexión.'
        )
      );
    }

    this.syllabusSignal.set(data ?? null);
    return data ?? null;
  }

  /**
   * Crea o actualiza el resumen del estudiante mediante UPSERT sobre user_id.
   * Evita generar registros duplicados gracias a la restricción UNIQUE (user_id).
   */
  public async saveSyllabus(content: string): Promise<SyllabusRecord> {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      throw new Error('El resumen no puede estar vacío. Escribe o pega tus apuntes antes de guardar.');
    }

    const user = await this.ensureAuthenticatedUser();
    if (!user) {
      throw new Error(
        'Debes iniciar sesión con tu cuenta antes de guardar el resumen en Supabase.'
      );
    }

    const payload: SyllabusUpsertPayload = {
      user_id: user.id,
      content: trimmedContent,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from('syllabus')
      .upsert(payload, { onConflict: 'user_id' })
      .select('id, content, user_id, created_at, updated_at')
      .single<SyllabusRecord>();

    if (error || !data) {
      throw new Error(
        this.translateSupabaseError(
          error?.message || '',
          'No se pudo guardar el resumen en Supabase. Inténtalo nuevamente.'
        )
      );
    }

    this.syllabusSignal.set(data);
    return data;
  }

  // ============================================================================
  // IMÁGENES DE SITUACIONES COTIDIANAS CON PERSONAS (1, 2 O GRUPO)
  // ============================================================================

  /**
   * Catálogo curado de fotografías que muestran exclusivamente a 1, 2 o un grupo
   * de personas en situaciones cotidianas (clase, consultorio médico, oficina,
   * turistas en la calle, cafetería, estudio, cocina, compras, etc.), evitando
   * paisajes vacíos sin personas.
   */
  private readonly peopleSituationPool: readonly string[] = [
    // Estudiantes y profesor en clase / grupo de estudio
    'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1577896851231-70ef18881754?auto=format&fit=crop&w=800&h=600&q=80',
    // Médica / enfermera atendiendo a paciente en consultorio u hospital
    'https://images.unsplash.com/photo-1579684385127-1ef15d508118?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1666214280557-f1b5022eb634?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?auto=format&fit=crop&w=800&h=600&q=80',
    // Dos personas o colegas conversando / debatiendo en el trabajo u oficina
    'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?auto=format&fit=crop&w=800&h=600&q=80',
    // Turistas / amigos en la calle mirando un mapa o pidiendo direcciones
    'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1516738901171-8eb4fc13bd20?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=800&h=600&q=80',
    // Personas en una cafetería o restaurante
    'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1521017432531-fbd92d768814?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1543269865-cbf427effbad?auto=format&fit=crop&w=800&h=600&q=80',
    // Cocinando o comiendo en familia / pareja
    'https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=800&h=600&q=80',
    // Compras en tienda / supermercado / farmacia
    'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1556740738-b6a63e27c4df?auto=format&fit=crop&w=800&h=600&q=80',
    // IDs verificados de Picsum Photos que contienen personas en escena (sin paisajes vacíos)
    'https://picsum.photos/id/1005/800/600',
    'https://picsum.photos/id/1011/800/600',
    'https://picsum.photos/id/1012/800/600',
    'https://picsum.photos/id/1027/800/600',
    'https://picsum.photos/id/338/800/600',
    'https://picsum.photos/id/342/800/600',
    'https://picsum.photos/id/375/800/600',
    'https://picsum.photos/id/447/800/600',
    'https://picsum.photos/id/453/800/600',
    'https://picsum.photos/id/669/800/600',
    'https://picsum.photos/id/823/800/600',
    'https://picsum.photos/id/838/800/600',
  ];

  /**
   * Selecciona aleatoriamente una fotografía que siempre incluye 1, 2 o un grupo
   * de personas en situaciones cotidianas de examen oral, sin repetir la anterior.
   */
  public generateRandomImageUrl(): string {
    const total = this.peopleSituationPool.length;
    let index = Math.floor(Math.random() * total);
    if (index === this.lastRandomSeed) {
      index = (index + 1) % total;
    }
    this.lastRandomSeed = index;
    const baseUrl = this.peopleSituationPool[index];
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}random=${Date.now()}`;
  }

  /**
   * Descarga la fotografía para obtener su URL estática y su representación en Base64.
   * De esta forma, el componente <ion-img> y el modelo multimodal Gemini analizan
   * exactamente la misma imagen.
   */
  public async preloadPracticeImage(
    picsumRandomUrl: string
  ): Promise<{ resolvedUrl: string; base64?: string; mimeType?: string }> {
    try {
      const response = await fetch(picsumRandomUrl, { mode: 'cors' });
      if (!response.ok) {
        throw new Error('No se pudo descargar la fotografía.');
      }

      const resolvedUrl = response.url || picsumRandomUrl;
      const blob = await response.blob();
      const mimeType = blob.type || 'image/jpeg';
      const base64 = await this.blobToBase64(blob);

      return {
        resolvedUrl,
        base64,
        mimeType,
      };
    } catch {
      // Si el navegador bloquea fetch por CORS o red lenta, mantenemos la URL original
      return {
        resolvedUrl: picsumRandomUrl,
      };
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          const base64Clean = reader.result.replace(
            /^data:[a-zA-Z0-9/+.-]+;base64,/,
            ''
          );
          resolve(base64Clean);
        } else {
          reject(new Error('No se pudo convertir el archivo a Base64.'));
        }
      };
      reader.onerror = () => reject(new Error('Error leyendo los datos binarios.'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Envía el audio grabado por el estudiante en el navegador (móvil o escritorio)
   * a la Edge Function para que Gemini lo transcriba fielmente al inglés.
   */
  public async transcribeAudio(audioBlob: Blob): Promise<string> {
    if (!audioBlob || audioBlob.size === 0) {
      throw new Error('La grabación de audio está vacía. Intenta hablar más cerca del micrófono.');
    }

    const audioBase64 = await this.blobToBase64(audioBlob);
    const audioMimeType = audioBlob.type || 'audio/webm';

    const { data, error } =
      await this.supabase.functions.invoke<TranscribeAudioResponse>(
        environment.geminiEdgeFunctionName,
        {
          body: {
            action: 'transcribe-audio',
            audioBase64,
            audioMimeType,
          },
        }
      );

    if (error) {
      throw new Error(
        this.translateEdgeFunctionError(
          error.message,
          'No se pudo transcribir tu grabación de voz en este momento. Inténtalo de nuevo.'
        )
      );
    }

    const transcript = (data?.transcript || '').trim();
    if (!transcript) {
      throw new Error(
        'No se detectó voz en inglés en la grabación. Intenta hablar con claridad cerca del micrófono.'
      );
    }

    return transcript;
  }

  // ============================================================================
  // COMUNICACIÓN CON GEMINI MEDIANTE SUPABASE EDGE FUNCTION
  // ============================================================================

  /**
   * Solicita 5 preguntas sencillas en inglés a Gemini a través de la Edge Function.
   */
  public async generateQuestions(
    syllabusContent: string,
    imageUrl: string,
    imageBase64?: string,
    imageMimeType?: string
  ): Promise<string[]> {
    const cleanSyllabus = syllabusContent.trim();
    if (!cleanSyllabus) {
      throw new Error('No existe un resumen válido para generar las preguntas.');
    }

    const { data, error } =
      await this.supabase.functions.invoke<GenerateQuestionsResponse>(
        environment.geminiEdgeFunctionName,
        {
          body: {
            action: 'generate-questions',
            syllabus: cleanSyllabus,
            imageUrl,
            imageBase64,
            imageMimeType,
          },
        }
      );

    if (error) {
      throw new Error(
        this.translateEdgeFunctionError(
          error.message,
          'No se pudieron generar las preguntas en este momento. Por favor, inténtalo de nuevo.'
        )
      );
    }

    if (!data || !Array.isArray(data.questions) || data.questions.length === 0) {
      throw new Error(
        'La IA no devolvió preguntas válidas para esta fotografía. Intenta generar una nueva práctica.'
      );
    }

    const cleanedQuestions = data.questions
      .map((q) => String(q).trim())
      .filter((q) => q.length > 0)
      .slice(0, 5);

    if (cleanedQuestions.length < 5) {
      throw new Error(
        'Se recibieron menos de cinco preguntas. Por favor, vuelve a intentar generar las preguntas.'
      );
    }

    return cleanedQuestions;
  }

  /**
   * Solicita a Gemini la corrección constructiva de la respuesta del estudiante.
   */
  public async evaluateAnswer(params: {
    syllabusContent: string;
    imageUrl: string;
    questions: string[];
    userAnswer: string;
    imageBase64?: string;
    imageMimeType?: string;
  }): Promise<AiFeedback> {
    const cleanAnswer = params.userAnswer.trim();
    if (!cleanAnswer) {
      throw new Error('La respuesta del estudiante está vacía.');
    }

    const { data, error } =
      await this.supabase.functions.invoke<EvaluateAnswerResponse>(
        environment.geminiEdgeFunctionName,
        {
          body: {
            action: 'evaluate-answer',
            syllabus: params.syllabusContent.trim(),
            imageUrl: params.imageUrl,
            questions: params.questions,
            userAnswer: cleanAnswer,
            imageBase64: params.imageBase64,
            imageMimeType: params.imageMimeType,
          },
        }
      );

    if (error) {
      throw new Error(
        this.translateEdgeFunctionError(
          error.message,
          'No se pudo generar la retroalimentación en este momento. Por favor, inténtalo de nuevo.'
        )
      );
    }

    if (!data || !data.feedback) {
      throw new Error('La respuesta de evaluación de Gemini llegó incompleta.');
    }

    return this.normalizeFeedback(data.feedback);
  }

  // ============================================================================
  // GESTIÓN DE LA SESIÓN DE PRÁCTICA ACTIVA Y GUARDADO EN SUPABASE
  // ============================================================================

  /**
   * Inicia o actualiza la sesión de práctica activa en memoria.
   */
  public setActiveSession(session: ActivePracticeSession): void {
    this.activeSessionSignal.set(session);
  }

  /**
   * Actualiza la respuesta del estudiante y/o la retroalimentación en la sesión activa.
   */
  public updateActiveSession(partial: Partial<ActivePracticeSession>): void {
    const current = this.activeSessionSignal();
    if (!current) {
      return;
    }
    this.activeSessionSignal.set({
      ...current,
      ...partial,
    });
  }

  /**
   * Guarda la práctica completada en la tabla `practices` de Supabase.
   * Evita guardar duplicados si la práctica actual ya fue registrada (`savedPracticeId`).
   */
  public async saveCurrentPractice(): Promise<PracticeRecord> {
    const session = this.activeSessionSignal();
    if (!session || !session.feedback) {
      throw new Error('No hay una práctica evaluada lista para guardar.');
    }

    // Si ya fue guardada en esta sesión, evitamos crear un registro duplicado
    if (session.savedPracticeId) {
      const existingFromHistory = this.practiceHistorySignal().find(
        (item) => item.id === session.savedPracticeId
      );
      if (existingFromHistory) {
        return existingFromHistory;
      }
    }

    const user = await this.ensureAuthenticatedUser();
    if (!user) {
      throw new Error('No hay una sesión autenticada en Supabase para guardar la práctica.');
    }

    const serializedFeedback = JSON.stringify(session.feedback);

    const payload: PracticeInsertPayload = {
      user_id: user.id,
      image_url: session.resolvedImageUrl || session.imageUrl,
      generated_questions: session.questions,
      user_answer: session.userAnswer.trim(),
      ai_feedback: serializedFeedback,
    };

    const { data, error } = await this.supabase
      .from('practices')
      .insert(payload)
      .select('id, user_id, image_url, generated_questions, user_answer, ai_feedback, created_at')
      .single<PracticeRecord>();

    if (error || !data) {
      throw new Error(
        this.translateSupabaseError(
          error?.message || '',
          'No se pudo guardar la práctica en Supabase. Verifica tu conexión a internet.'
        )
      );
    }

    this.activeSessionSignal.set({
      ...session,
      savedPracticeId: data.id,
      savedCreatedAt: data.created_at,
    });

    this.practiceHistorySignal.update((prev) => [data, ...prev]);
    return data;
  }

  /**
   * Consulta el historial de prácticas del estudiante ordenadas desde la más reciente.
   */
  public async getPracticeHistory(limit = 10): Promise<PracticeRecord[]> {
    const user = await this.ensureAuthenticatedUser();
    if (!user) {
      return [];
    }

    const { data, error } = await this.supabase
      .from('practices')
      .select('id, user_id, image_url, generated_questions, user_answer, ai_feedback, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<PracticeRecord[]>();

    if (error || !data) {
      throw new Error(
        this.translateSupabaseError(
          error?.message || '',
          'No se pudo consultar el historial de prácticas.'
        )
      );
    }

    this.practiceHistorySignal.set(data);
    return data;
  }

  /**
   * Carga una práctica del historial en la vista de Feedback sin volver a guardarla.
   */
  public loadPracticeIntoFeedback(record: PracticeRecord, syllabusContent: string): void {
    const parsedFeedback = this.parseStoredFeedback(record.ai_feedback);
    this.activeSessionSignal.set({
      sessionKey: `history-${record.id}`,
      syllabusContent,
      imageUrl: record.image_url,
      resolvedImageUrl: record.image_url,
      questions: Array.isArray(record.generated_questions)
        ? record.generated_questions
        : [],
      userAnswer: record.user_answer,
      feedback: parsedFeedback,
      savedPracticeId: record.id,
      savedCreatedAt: record.created_at,
    });
  }

  /**
   * Convierte el campo `ai_feedback` almacenado en Supabase (JSON o texto Markdown)
   * en una estructura tipada `AiFeedback`.
   */
  public parseStoredFeedback(stored: string): AiFeedback {
    try {
      const parsed = JSON.parse(stored) as Partial<AiFeedback>;
      if (parsed && (Array.isArray(parsed.errores) || Array.isArray(parsed.aciertos))) {
        return this.normalizeFeedback(parsed);
      }
    } catch {
      // Si no es JSON, se procesa como bloques de texto por secciones
    }

    return {
      hasErrors: false,
      noErrorsMessage: 'La respuesta no presenta errores gramaticales relevantes.',
      errores: [],
      aciertos: [stored.trim() || 'Práctica registrada correctamente.'],
      sugerencias: [],
      rawMarkdown: stored,
    };
  }

  private normalizeFeedback(raw: Partial<AiFeedback>): AiFeedback {
    const errores: FeedbackErrorItem[] = Array.isArray(raw.errores)
      ? raw.errores
          .filter((item) => Boolean(item?.original || item?.corrected || item?.explanation))
          .map((item) => ({
            original: String(item.original || '').trim(),
            corrected: String(item.corrected || '').trim(),
            explanation: String(item.explanation || '').trim(),
          }))
      : [];

    const aciertos: string[] = Array.isArray(raw.aciertos)
      ? raw.aciertos.map((item) => String(item).trim()).filter((item) => item.length > 0)
      : [];

    const sugerencias: FeedbackSuggestionItem[] = Array.isArray(raw.sugerencias)
      ? raw.sugerencias
          .filter((item) => Boolean(item?.advice))
          .map((item) => ({
            advice: String(item.advice || '').trim(),
            example: item.example ? String(item.example).trim() : undefined,
          }))
      : [];

    return {
      hasErrors: Boolean(errores.length > 0),
      noErrorsMessage:
        raw.noErrorsMessage?.trim() ||
        '¡Muy bien! Tu respuesta no presenta errores gramaticales relevantes.',
      errores,
      aciertos,
      sugerencias,
      rawMarkdown: raw.rawMarkdown,
    };
  }

  // ============================================================================
  // MANEJO DE ERRORES AMIGABLES PARA EL ESTUDIANTE
  // ============================================================================

  private translateSupabaseError(rawMessage: string, fallback = 'Ocurrió un error al comunicarse con Supabase.'): string {
    const lower = (rawMessage || '').toLowerCase();

    if (lower.includes('failed to fetch') || lower.includes('network')) {
      return 'Se perdió la conexión con Supabase. Verifica tu conexión a internet e inténtalo de nuevo.';
    }
    if (lower.includes('invalid login credentials')) {
      return 'El correo o la contraseña son incorrectos.';
    }
    if (lower.includes('user already registered')) {
      return 'Este correo electrónico ya está registrado. Inicia sesión con tu contraseña.';
    }
    if (lower.includes('anonymous sign-ins are disabled')) {
      return 'El inicio de sesión anónimo está deshabilitado en Supabase. Inicia sesión con tu correo y contraseña o habilita "Anonymous Sign-Ins" en Supabase Auth.';
    }
    if (lower.includes('row-level security') || lower.includes('permission denied')) {
      return 'No tienes permisos para acceder a este registro. Inicia sesión con tu cuenta.';
    }
    if (lower.includes('relation') && lower.includes('does not exist')) {
      return 'Las tablas de la base de datos aún no existen. Ejecuta primero el script supabase/schema.sql en el SQL Editor de Supabase.';
    }

    return fallback;
  }

  private translateEdgeFunctionError(rawMessage: string, fallback: string): string {
    const lower = (rawMessage || '').toLowerCase();

    if (lower.includes('failed to fetch') || lower.includes('network')) {
      return 'No se pudo conectar con el servicio de evaluación. Verifica tu conexión a internet e inténtalo de nuevo.';
    }
    if (lower.includes('quota') || lower.includes('429')) {
      return 'El servicio de inteligencia artificial está recibiendo muchas consultas en este momento. Espera unos segundos e inténtalo de nuevo.';
    }

    return fallback;
  }
}
