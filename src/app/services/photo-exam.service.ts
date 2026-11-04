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
  QuestionReviewItem,
  SyllabusRecord,
  SyllabusUpsertPayload,
  TranscribeAudioResponse,
  VocabularyItem,
} from '../models/photo-exam.models';

@Injectable({
  providedIn: 'root',
})
export class PhotoExamService {
  private readonly platform = inject(Platform);
  private readonly supabase: SupabaseClient;
  private lastRandomSeed = 0;
  private authInitPromise: Promise<AuthUserState | null> | null = null;
  private readonly syllabusStorageKey = 'photoexams_syllabus_cache_v1';

  private readonly defaultExamSyllabus = `ORAL EXAM GRAMMAR & VOCABULARY:
1. Identification, Place & Appearance:
   - Who is he/she? Who are they? Where are they?
   - What does he/she look like? Describe the person in the picture (tall, slim, young, middle-aged, curly/straight/dark/blonde hair, wearing a jacket/shirt/glasses).
2. Feelings & Present Actions (Present Continuous):
   - How is she/the man feeling? (happy, worried, tired, focused, relaxed, nervous).
   - What are they doing? What is he/she doing right now?
3. Recent Events & Duration (Present Perfect):
   - What has happened? What has happened to her/him?
   - How long has he/she been there? (for two hours, since this morning).
4. Past Habits & Changes (Past Simple & Used to):
   - How was his/her life different in the past?
   - What did he/she use to do when he/she was younger? (He/she used to...).
5. Advice & Future Plans (Should / Would / Going to / Will):
   - What advice would you give him/her? (I would advise him to..., He should...).
   - What is he/she going to do after this? What is his wife / her friend going to do?
   - What are his/her plans for the weekend? What will happen next / later?`;

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
    this.syllabusSignal.set(this.loadCachedOrDefaultSyllabus());

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

  private loadCachedOrDefaultSyllabus(): SyllabusRecord {
    try {
      const raw = localStorage.getItem(this.syllabusStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as SyllabusRecord;
        if (parsed && typeof parsed.content === 'string' && parsed.content.trim().length > 0) {
          return parsed;
        }
      }
    } catch {
      // Ignorar errores de almacenamiento local
    }

    const now = new Date().toISOString();
    return {
      id: 'local-default-syllabus',
      user_id: 'local-user',
      content: this.defaultExamSyllabus,
      created_at: now,
      updated_at: now,
    };
  }

  private saveSyllabusToLocalCache(record: SyllabusRecord): void {
    try {
      localStorage.setItem(this.syllabusStorageKey, JSON.stringify(record));
    } catch {
      // Ignorar si el navegador restringe localStorage
    }
  }

  // ============================================================================
  // AUTENTICACIÓN Y SESIÓN DE USUARIO (RLS)
  // ============================================================================

  /**
   * Garantiza que exista una sesión autenticada válida (con access_token activo)
   * en Supabase para cumplir con RLS.
   */
  public async ensureAuthenticatedUser(): Promise<AuthUserState | null> {
    const existing = this.authUserSignal();
    if (existing) {
      return existing;
    }

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
  // OPERACIONES DE RESUMEN (TABLA: syllabus + CACHÉ INSTANTÁNEA)
  // ============================================================================

  /**
   * Obtiene el resumen de gramática y vocabulario guardado por el estudiante.
   * Si ya está en memoria o en caché local, lo devuelve en 0ms sin esperar red,
   * y sincroniza silenciosamente en segundo plano con Supabase.
   */
  public async getSyllabus(forceRefresh = false): Promise<SyllabusRecord | null> {
    const cached = this.syllabusSignal();
    if (!forceRefresh && cached && cached.content.trim().length > 0) {
      void this.syncSyllabusInBackground();
      return cached;
    }

    const user = await this.ensureAuthenticatedUser();
    if (!user) {
      return cached ?? this.loadCachedOrDefaultSyllabus();
    }

    const { data, error } = await this.supabase
      .from('syllabus')
      .select('id, content, user_id, created_at, updated_at')
      .eq('user_id', user.id)
      .maybeSingle<SyllabusRecord>();

    if (!error && data && data.content.trim().length > 0) {
      this.syllabusSignal.set(data);
      this.saveSyllabusToLocalCache(data);
      return data;
    }

    return cached ?? this.loadCachedOrDefaultSyllabus();
  }

  private async syncSyllabusInBackground(): Promise<void> {
    try {
      const user = await this.ensureAuthenticatedUser();
      if (!user) {
        return;
      }
      const { data, error } = await this.supabase
        .from('syllabus')
        .select('id, content, user_id, created_at, updated_at')
        .eq('user_id', user.id)
        .maybeSingle<SyllabusRecord>();

      if (!error && data && data.content.trim().length > 0) {
        this.syllabusSignal.set(data);
        this.saveSyllabusToLocalCache(data);
      }
    } catch {
      // Silencioso en segundo plano
    }
  }

  /**
   * Crea o actualiza el resumen del estudiante guardándolo primero en caché local
   * instantánea y sincronizándolo en Supabase si hay sesión activa.
   */
  public async saveSyllabus(content: string): Promise<SyllabusRecord> {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      throw new Error('El resumen no puede estar vacío. Escribe o pega tus apuntes antes de guardar.');
    }

    const now = new Date().toISOString();
    const localRecord: SyllabusRecord = {
      id: this.syllabusSignal()?.id || 'local-syllabus',
      user_id: this.authUserSignal()?.id || 'local-user',
      content: trimmedContent,
      created_at: this.syllabusSignal()?.created_at || now,
      updated_at: now,
    };

    // Guardamos inmediatamente en memoria y en localStorage para que nunca se pierda ni pida recargar
    this.syllabusSignal.set(localRecord);
    this.saveSyllabusToLocalCache(localRecord);

    const user = await this.ensureAuthenticatedUser();
    if (!user) {
      return localRecord;
    }

    const payload: SyllabusUpsertPayload = {
      user_id: user.id,
      content: trimmedContent,
      updated_at: now,
    };

    const { data, error } = await this.supabase
      .from('syllabus')
      .upsert(payload, { onConflict: 'user_id' })
      .select('id, content, user_id, created_at, updated_at')
      .single<SyllabusRecord>();

    if (!error && data) {
      this.syllabusSignal.set(data);
      this.saveSyllabusToLocalCache(data);
      return data;
    }

    return localRecord;
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
    'https://images.unsplash.com/photo-1517486808906-6ca8b3f04846?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=800&h=600&q=80',
    // Personas en una cafetería o restaurante
    'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1521017432531-fbd92d768814?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1543269865-cbf427effbad?auto=format&fit=crop&w=800&h=600&q=80',
    // Cocinando o comiendo en familia / pareja
    'https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=800&h=600&q=80',
    'https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=800&h=600&q=80',
    // Compras en tienda / supermercado / farmacia con personas
    'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=800&h=600&q=80',
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
   * de personas en situaciones cotidianas de examen oral, sin repetir la anterior
   * y permitiendo que el navegador aproveche la caché de CDN.
   */
  public generateRandomImageUrl(): string {
    const total = this.peopleSituationPool.length;
    let index = Math.floor(Math.random() * total);
    if (index === this.lastRandomSeed) {
      index = (index + 1) % total;
    }
    this.lastRandomSeed = index;
    return this.peopleSituationPool[index];
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
          const commaIndex = reader.result.indexOf(',');
          const base64Clean = (
            commaIndex !== -1 ? reader.result.slice(commaIndex + 1) : reader.result
          ).replace(/\s+/g, '');
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
    const audioMimeType = (audioBlob.type || 'audio/webm').split(';')[0].trim();

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

  // Las 6 preguntas prioritarias que le toman en el examen (incluyendo la del sueño repetido)
  private readonly priorityPersonalQuestions: readonly string[] = [
    'Have you ever had the same dream more than once? Describe it.',
    'What kind of people do you get on with? Why?',
    'Are you studying anything at the moment? How long have you studied that? When did you start?',
    'Tell us about your past habits.',
    'What should you do when you have a headache, a stomachache or a cough?',
    'How long have you studied English? Where did you start studying?',
  ];

  private readonly realPersonalQuestionsPool: readonly string[] = [
    ...this.priorityPersonalQuestions,
    'Do you dream regularly? Do you remember your dreams?',
    'What will you do if someone phones you during the English class?',
    "When was the last time you went to the doctor's? Why?",
    'Why are you studying English?',
    'Are you more of an optimist or a pessimist?',
    'What rules are there at the place where you work?',
    'Tell us about something you are excellent at and something you are terrible at doing.',
    'Tell us two tips for someone who is starting a new job next Monday.',
  ];

  private pickRandomPersonalQuestions(count = 4): string[] {
    const priorityShuffled = [...this.priorityPersonalQuestions].sort(() => Math.random() - 0.5);
    const others = this.realPersonalQuestionsPool
      .filter((q) => !this.priorityPersonalQuestions.includes(q))
      .sort(() => Math.random() - 0.5);
    // Garantiza al menos 2 o 3 de las nuevas preguntas prioritarias en cada tarjeta
    const combined = [...priorityShuffled.slice(0, 3), ...others.slice(0, 2)].sort(
      () => Math.random() - 0.5
    );
    return combined.slice(0, count);
  }

  /**
   * Normaliza cada pregunta de "1) Talk about the picture" para que sea siempre CORTA y GENERAL
   * como en la hoja real del examen (adaptando solo he/she/they/the man/the woman/his wife/her friend
   * y quitando agregados específicos como "with the laptop" o "if they have to finish a project today").
   */
  private normalizeGeneralPictureQuestion(rawQuestion: string): string {
    const q = rawQuestion.trim();
    const lower = q.toLowerCase();

    const isPlural =
      /\b(they|them|their|people|friends|colleagues|students|couples|men|women)\b/i.test(q);
    const isFemale = !isPlural && /\b(she|her|woman|girl|lady|mother|wife)\b/i.test(q);

    // 1. "What are they doing with the laptop?" -> "What are they doing?"
    if (/^what\s+(is|are)\s+.+?\bdoing\b/i.test(q)) {
      if (isPlural) {
        return 'What are they doing?';
      }
      if (/\bthe woman\b/i.test(q)) {
        return 'What is the woman doing?';
      }
      if (/\bthe man\b/i.test(q)) {
        return 'What is the man doing?';
      }
      return isFemale ? 'What is she doing?' : 'What is he doing?';
    }

    // 2. "What advice would you give them if they have to finish a project today?" -> "What advice would you give them?"
    if (/^what\s+advice\s+would\s+you\s+give\b/i.test(q)) {
      if (isPlural || /\bthem\b/i.test(q)) {
        return 'What advice would you give them?';
      }
      return isFemale ? 'What advice would you give her?' : 'What advice would you give him?';
    }

    // 3. "What will happen if they don't stop laughing...?" -> "What will happen next?" / "What will happen later?"
    if (/^what\s+will\s+happen\b/i.test(q)) {
      return /\blater\b/i.test(q) ? 'What will happen later?' : 'What will happen next?';
    }

    // 4. "How long has he been in that room...?" -> "How long has he been there?"
    if (/^how\s+long\s+(has|have)\b/i.test(q)) {
      if (isPlural) {
        return 'How long have they been there?';
      }
      return isFemale ? 'How long has she been there?' : 'How long has he been there?';
    }

    // 5. "How is the man feeling at this moment?" -> "How is the man feeling?" (manteniendo "¿What has happened?" si viene junto)
    if (/^how\s+(is|are)\b/i.test(q) && /\bfeeling\b/i.test(q)) {
      const hasHappenedPart = /\bwhat\s+has\s+happened/i.test(q);
      if (isPlural) {
        return hasHappenedPart
          ? 'How are they feeling? What has happened?'
          : 'How are they feeling?';
      }
      if (/\bthe man\b/i.test(q)) {
        return hasHappenedPart
          ? 'How is the man feeling? What has happened?'
          : 'How is the man feeling?';
      }
      if (/\bthe woman\b/i.test(q)) {
        return hasHappenedPart
          ? 'How is the woman feeling? What has happened?'
          : 'How is the woman feeling?';
      }
      if (isFemale) {
        return hasHappenedPart
          ? 'How is she feeling? What has happened to her?'
          : 'How is she feeling?';
      }
      return hasHappenedPart
        ? 'How is he feeling? What has happened?'
        : 'How is he feeling?';
    }

    // 6. "What has happened to..." -> "What has happened?" / "What has happened to her/him?"
    if (/^what\s+has\s+happened\b/i.test(q)) {
      if (isPlural) {
        return 'What has happened?';
      }
      if (isFemale && /\bto her\b/i.test(q)) {
        return 'What has happened to her?';
      }
      if (!isFemale && /\bto him\b/i.test(q)) {
        return 'What has happened to him?';
      }
      return 'What has happened?';
    }

    // 7. "Who are they and where are they...?" -> "Who are they? Where are they?"
    if (/^who\s+(is|are)\b/i.test(q) || /^where\s+(is|are)\b/i.test(q)) {
      if (isPlural) {
        return 'Who are they? Where are they?';
      }
      return isFemale ? 'Who is she? Where is she?' : 'Who is he? Where is he?';
    }

    // 8. "What is his wife / he / she going to do...?"
    if (/\bgoing\s+to\s+do\b/i.test(q)) {
      if (/\bhis wife\b/i.test(q)) {
        return 'What is his wife going to do?';
      }
      if (/\bher husband\b/i.test(q)) {
        return 'What is her husband going to do?';
      }
      if (/\bfriend\b/i.test(q)) {
        return isFemale
          ? 'What is her friend going to do?'
          : 'What is his friend going to do?';
      }
      if (isPlural) {
        return 'What are they going to do after this?';
      }
      return isFemale
        ? 'What is she going to do after this?'
        : 'What is he going to do after this?';
    }

    // 9. "How was his/her life different in the past..."
    if (/^how\s+was\b/i.test(q) && /\blife\s+different\b/i.test(q)) {
      if (isPlural) {
        return 'How was their life different in the past?';
      }
      return isFemale
        ? 'How was her life different in the past?'
        : 'How was his life different in the past?';
    }

    // 10. "What did he/she use to do when..."
    if (/\buse\s+to\s+do\b/i.test(q)) {
      if (isPlural) {
        return 'What did they use to do when they were younger?';
      }
      return isFemale
        ? 'What did she use to do when she was younger?'
        : 'What did he use to do when he was younger?';
    }

    // 11. "What are his/her/their plans for the weekend..."
    if (/\bplans\s+for\s+the\s+weekend\b/i.test(q)) {
      if (isPlural) {
        return 'What are their plans for the weekend?';
      }
      return isFemale
        ? 'What are her plans for the weekend?'
        : 'What are his plans for the weekend?';
    }

    // 12. "What does he/she look like..."
    if (/\blook\s+like\b/i.test(lower)) {
      if (isPlural) {
        return 'Describe the people in the picture.';
      }
      return isFemale ? 'What does she look like?' : 'What does he look like?';
    }

    return q;
  }

  /**
   * Solicita 5 preguntas de la imagen + 4 preguntas personales + 3 palabras de vocabulario a Gemini.
   */
  public async generateQuestions(
    syllabusContent: string,
    imageUrl: string,
    imageBase64?: string,
    imageMimeType?: string
  ): Promise<{
    questions: string[];
    personalQuestions: string[];
    vocabulary: VocabularyItem[];
  }> {
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
      .map((q) => this.normalizeGeneralPictureQuestion(String(q).trim()))
      .filter((q) => q.length > 0)
      .slice(0, 5);

    if (cleanedQuestions.length < 5) {
      throw new Error(
        'Se recibieron menos de cinco preguntas. Por favor, vuelve a intentar generar las preguntas.'
      );
    }

    const rawPersonal = Array.isArray(data.personalQuestions)
      ? data.personalQuestions
          .map((q) => String(q).trim())
          .filter((q) => q.length > 0)
          .slice(0, 4)
      : [];

    // Combinamos las preguntas prioritarias de su examen real con las de la IA sin duplicarlas
    const priorityPicks = this.pickRandomPersonalQuestions(4);
    const mergedPersonal = Array.from(
      new Set([...priorityPicks.slice(0, 2), ...rawPersonal, ...priorityPicks.slice(2)])
    ).slice(0, 4);

    const personalQuestions =
      mergedPersonal.length === 4 ? mergedPersonal : this.pickRandomPersonalQuestions(4);

    const fallbackVocab: VocabularyItem[] = [
      {
        word: 'In the background',
        meaning: 'al fondo (de la imagen)',
        example: 'In the background, we can see the building.',
      },
      {
        word: 'Seem to be',
        meaning: 'parecer estar',
        example: 'They seem to be having an important conversation.',
      },
      {
        word: 'Point out',
        meaning: 'señalar / mostrar',
        example: 'One person is pointing out something to the other.',
      },
    ];

    const rawVocab = Array.isArray(data.vocabulary)
      ? data.vocabulary
          .filter((v) => v && v.word && v.meaning)
          .map((v) => ({
            word: String(v.word).trim(),
            meaning: String(v.meaning).trim(),
            example: String(v.example || '').trim(),
          }))
          .slice(0, 3)
      : [];

    const vocabulary =
      rawVocab.length === 3
        ? rawVocab
        : [...rawVocab, ...fallbackVocab].slice(0, 3);

    return {
      questions: cleanedQuestions,
      personalQuestions,
      vocabulary,
    };
  }

  /**
   * Solicita a Gemini la corrección constructiva de todas las respuestas del estudiante
   * (acepta respuestas escritas, grabaciones de voz individuales por pregunta, o ambas en un solo paso).
   */
  public async evaluateAnswer(params: {
    syllabusContent: string;
    imageUrl: string;
    questions: string[];
    userAnswer: string;
    imageBase64?: string;
    imageMimeType?: string;
    audioBlob?: Blob | null;
    audioParts?: Array<{ label: string; blob: Blob }>;
  }): Promise<AiFeedback> {
    const cleanAnswer = params.userAnswer.trim();
    const validAudioBlobs = (params.audioParts || []).filter(
      (item) => item.blob && item.blob.size > 0
    );
    const hasSingleAudio = Boolean(params.audioBlob && params.audioBlob.size > 0);
    const hasAudio = hasSingleAudio || validAudioBlobs.length > 0;

    if (!cleanAnswer && !hasAudio) {
      throw new Error('La respuesta del estudiante está vacía.');
    }

    let audioBase64: string | undefined;
    let audioMimeType: string | undefined;
    let serializedAudioParts:
      | Array<{ label: string; audioBase64: string; audioMimeType: string }>
      | undefined;

    if (validAudioBlobs.length > 0) {
      serializedAudioParts = await Promise.all(
        validAudioBlobs.map(async (item) => ({
          label: item.label,
          audioBase64: await this.blobToBase64(item.blob),
          audioMimeType: (item.blob.type || 'audio/mp4').split(';')[0].trim(),
        }))
      );
    } else if (params.audioBlob && params.audioBlob.size > 0) {
      audioBase64 = await this.blobToBase64(params.audioBlob);
      audioMimeType = (params.audioBlob.type || 'audio/mp4').split(';')[0].trim();
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
            audioBase64,
            audioMimeType,
            audioParts: serializedAudioParts,
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

    const questionReviews: QuestionReviewItem[] = Array.isArray(raw.questionReviews)
      ? raw.questionReviews
          .filter((item) => Boolean(item?.title || item?.correction))
          .map((item) => ({
            title: String(item.title || 'Parte evaluada').trim(),
            studentAnswer: String(item.studentAnswer || '').trim(),
            correction: String(item.correction || '').trim(),
            simplePhrases: Array.isArray(item.simplePhrases)
              ? item.simplePhrases
                  .map((p) => String(p).trim())
                  .filter((p) => p.length > 0)
              : [],
            suggestedVocab: Array.isArray(item.suggestedVocab)
              ? item.suggestedVocab
                  .map((v) => String(v).trim())
                  .filter((v) => v.length > 0)
              : [],
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
      questionReviews,
      transcript: raw.transcript?.trim(),
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
