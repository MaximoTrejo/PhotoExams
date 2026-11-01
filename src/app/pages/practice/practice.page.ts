import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonHeader,
  IonFooter,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardSubtitle,
  IonCardContent,
  IonImg,
  IonTextarea,
  IonSkeletonText,
  IonSpinner,
  IonIcon,
  ViewWillEnter,
  ViewWillLeave,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  bookOutline,
  cameraOutline,
  refreshOutline,
  sendOutline,
  alertCircleOutline,
  createOutline,
  imageOutline,
  micOutline,
  stopCircleOutline,
  volumeHighOutline,
  trashOutline,
  expandOutline,
  closeOutline,
  bulbOutline,
  eyeOutline,
  eyeOffOutline,
  checkmarkCircleOutline,
  gridOutline,
  listOutline,
} from 'ionicons/icons';
import { VocabularyItem } from '../../models/photo-exam.models';
import { PhotoExamService } from '../../services/photo-exam.service';

export interface ItemAnswerState {
  audioBlob: Blob | null;
  audioUrl: string | null;
  text: string;
  showTextInput: boolean;
}

@Component({
  selector: 'app-practice',
  templateUrl: './practice.page.html',
  styleUrls: ['./practice.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    IonHeader,
    IonFooter,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardSubtitle,
    IonCardContent,
    IonImg,
    IonTextarea,
    IonSkeletonText,
    IonSpinner,
    IonIcon,
  ],
})
export class PracticePage implements OnInit, OnDestroy, ViewWillEnter, ViewWillLeave {
  public readonly photoExamService = inject(PhotoExamService);
  private readonly router = inject(Router);
  private readonly alertController = inject(AlertController);

  public syllabusContent = '';
  public hasSavedSyllabus = false;

  public imageUrl = '';
  public displayImageUrl = '';
  public imageBase64?: string;
  public imageMimeType?: string;

  public questions: string[] = [];
  public personalQuestions: string[] = [];
  public revealedPersonalMap: Record<number, boolean> = {};
  public speakingPersonalIndex: number | null = null;

  public vocabulary: VocabularyItem[] = [];
  public selectedVocabIndex = 0;
  // Por defecto las 3 palabras aparecen ocultas hasta tocar el botón de ojo
  public isVocabVisible = false;

  // Selector entre forma Compacta (una sola hoja sin scroll como la card impresa) y forma Completa (amplia)
  public viewMode: 'compact' | 'full' = 'compact';
  public isPhotoExpanded = false;

  public isCheckingSyllabus = false;
  public isLoadingImage = false;
  public hasImageError = false;
  public isGeneratingQuestions = false;
  public isSubmittingAnswer = false;

  // Respuestas individuales por bloque: 'picture' y 'personal-0'..'personal-3'
  public itemAnswers: Record<string, ItemAnswerState> = {};
  public activeRecordingKey: string | null = null;
  public processingAudioKey: string | null = null;

  // Estados de grabación de respuesta oral
  public isRecordingAudio = false;
  public isProcessingAudio = false;
  public recordingSeconds = 0;
  public voiceError: string | null = null;

  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];
  private recordingTimerId: ReturnType<typeof setInterval> | null = null;

  public syllabusError: string | null = null;
  public questionsError: string | null = null;
  public answerError: string | null = null;

  public readonly skeletonItems = [1, 2, 3, 4, 5];

  constructor() {
    addIcons({
      bookOutline,
      cameraOutline,
      refreshOutline,
      sendOutline,
      alertCircleOutline,
      createOutline,
      imageOutline,
      micOutline,
      stopCircleOutline,
      volumeHighOutline,
      trashOutline,
      expandOutline,
      closeOutline,
      bulbOutline,
      eyeOutline,
      eyeOffOutline,
      checkmarkCircleOutline,
      gridOutline,
      listOutline,
    });
    this.resetAllItemAnswers();
  }

  public setViewMode(mode: 'compact' | 'full'): void {
    this.viewMode = mode;
  }

  public ngOnInit(): void {
    void this.initializePracticeScreen(false);
  }

  public ionViewWillEnter(): void {
    void this.initializePracticeScreen(false);
  }

  public ionViewWillLeave(): void {
    this.stopSpeakingQuestion();
    this.cleanupMicrophoneResources();
  }

  public ngOnDestroy(): void {
    this.stopSpeakingQuestion();
    this.cleanupMicrophoneResources();
    this.revokeAllAudioUrls();
  }

  // ============================================================================
  // GESTIÓN DE ESTADO POR BLOQUE ('picture' y 'personal-0'..'personal-3')
  // ============================================================================

  public getPersonalKey(index: number): string {
    return `personal-${index}`;
  }

  public getItemState(key: string): ItemAnswerState {
    if (!this.itemAnswers[key]) {
      this.itemAnswers[key] = {
        audioBlob: null,
        audioUrl: null,
        text: '',
        showTextInput: false,
      };
    }
    return this.itemAnswers[key];
  }

  public isItemAnswered(key: string): boolean {
    const state = this.itemAnswers[key];
    if (!state) {
      return false;
    }
    return (
      (state.audioBlob !== null && state.audioBlob.size > 0) ||
      state.text.trim().length > 0
    );
  }

  public get hasAnyAnswer(): boolean {
    return Object.keys(this.itemAnswers).some((key) => this.isItemAnswered(key));
  }

  public get answeredBlocksCount(): number {
    let count = 0;
    if (this.isItemAnswered('picture')) {
      count += 1;
    }
    for (let i = 0; i < this.personalQuestions.length; i++) {
      if (this.isItemAnswered(this.getPersonalKey(i))) {
        count += 1;
      }
    }
    return count;
  }

  public get totalBlocksCount(): number {
    return 1 + (this.personalQuestions.length || 4);
  }

  public toggleItemTextInput(key: string): void {
    const state = this.getItemState(key);
    state.showTextInput = !state.showTextInput;
  }

  public onItemTextChange(key: string, value: string): void {
    const state = this.getItemState(key);
    state.text = value;
    if (this.answerError && value.trim().length > 0) {
      this.answerError = null;
    }
  }

  public clearItemAudio(key: string): void {
    const state = this.itemAnswers[key];
    if (!state) {
      return;
    }
    if (state.audioUrl) {
      URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = null;
    }
    state.audioBlob = null;
  }

  private resetAllItemAnswers(): void {
    this.revokeAllAudioUrls();
    this.itemAnswers = {
      picture: {
        audioBlob: null,
        audioUrl: null,
        text: '',
        showTextInput: false,
      },
    };
    for (let i = 0; i < 4; i++) {
      this.itemAnswers[this.getPersonalKey(i)] = {
        audioBlob: null,
        audioUrl: null,
        text: '',
        showTextInput: false,
      };
    }
  }

  private revokeAllAudioUrls(): void {
    for (const key of Object.keys(this.itemAnswers)) {
      const url = this.itemAnswers[key]?.audioUrl;
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  }

  // ============================================================================
  // CONTROLES DE VOCABULARIO, FOTO Y AUDIO DE PREGUNTAS PERSONALES
  // ============================================================================

  public selectVocab(index: number): void {
    this.selectedVocabIndex = index;
  }

  public toggleVocabVisibility(): void {
    this.isVocabVisible = !this.isVocabVisible;
  }

  public togglePhotoExpanded(): void {
    this.isPhotoExpanded = !this.isPhotoExpanded;
  }

  public togglePersonalQuestionTranscript(index: number): void {
    this.revealedPersonalMap = {
      ...this.revealedPersonalMap,
      [index]: !this.revealedPersonalMap[index],
    };
  }

  public speakPersonalQuestion(index: number, slow = false): void {
    const questionText = this.personalQuestions[index];
    if (!questionText || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(questionText);
      utterance.lang = 'en-GB';
      utterance.rate = slow ? 0.78 : 0.96;

      const voices = window.speechSynthesis.getVoices();
      const englishVoice =
        voices.find((v) => v.lang.startsWith('en-GB')) ||
        voices.find((v) => v.lang.startsWith('en-US')) ||
        voices.find((v) => v.lang.startsWith('en'));
      if (englishVoice) {
        utterance.voice = englishVoice;
      }

      this.speakingPersonalIndex = index;
      utterance.onend = () => {
        if (this.speakingPersonalIndex === index) {
          this.speakingPersonalIndex = null;
        }
      };
      utterance.onerror = () => {
        if (this.speakingPersonalIndex === index) {
          this.speakingPersonalIndex = null;
        }
      };

      window.speechSynthesis.speak(utterance);
    } catch {
      this.speakingPersonalIndex = null;
    }
  }

  public stopSpeakingQuestion(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.speakingPersonalIndex = null;
  }

  // ============================================================================
  // CARGA DE SESIÓN Y GENERACIÓN DE TARJETA DE EXAMEN
  // ============================================================================

  public async initializePracticeScreen(forceNewPractice: boolean): Promise<void> {
    if (this.isCheckingSyllabus || this.isGeneratingQuestions || this.isSubmittingAnswer) {
      return;
    }

    this.isCheckingSyllabus = true;
    this.syllabusError = null;
    this.questionsError = null;
    this.answerError = null;

    try {
      const syllabusRecord = await this.photoExamService.getSyllabus();
      if (!syllabusRecord || !syllabusRecord.content.trim()) {
        this.hasSavedSyllabus = false;
        this.syllabusContent = '';
        return;
      }

      this.hasSavedSyllabus = true;
      this.syllabusContent = syllabusRecord.content.trim();

      const existingSession = this.photoExamService.activeSession();
      if (
        !forceNewPractice &&
        existingSession &&
        existingSession.questions.length === 5 &&
        existingSession.syllabusContent === this.syllabusContent &&
        !existingSession.feedback
      ) {
        this.imageUrl = existingSession.imageUrl;
        this.displayImageUrl = existingSession.resolvedImageUrl || existingSession.imageUrl;
        this.imageBase64 = existingSession.imageBase64;
        this.imageMimeType = existingSession.imageMimeType;
        this.questions = [...existingSession.questions];
        this.personalQuestions = existingSession.personalQuestions
          ? [...existingSession.personalQuestions]
          : [];
        this.revealedPersonalMap = {};
        this.vocabulary = existingSession.vocabulary ? [...existingSession.vocabulary] : [];
        this.selectedVocabIndex = 0;
        this.isLoadingImage = false;
        this.hasImageError = false;
        return;
      }

      await this.startNewPracticeSession();
    } catch (error: unknown) {
      this.syllabusError =
        error instanceof Error
          ? error.message
          : 'No se pudo comprobar tu resumen en Supabase.';
    } finally {
      this.isCheckingSyllabus = false;
    }
  }

  public async onRequestNewPractice(): Promise<void> {
    if (
      this.isGeneratingQuestions ||
      this.isSubmittingAnswer ||
      this.isRecordingAudio ||
      this.isProcessingAudio
    ) {
      return;
    }

    if (this.hasAnyAnswer) {
      const alert = await this.alertController.create({
        header: '¿Generar nueva Card de examen?',
        message:
          'Ya tienes respuestas grabadas o escritas en esta tarjeta. Si generas otra ahora, se reiniciarán las respuestas actuales.',
        buttons: [
          {
            text: 'Cancelar',
            role: 'cancel',
          },
          {
            text: 'Nueva Card',
            role: 'confirm',
            handler: () => {
              void this.startNewPracticeSession();
            },
          },
        ],
      });
      await alert.present();
      return;
    }

    await this.startNewPracticeSession();
  }

  public async startNewPracticeSession(): Promise<void> {
    if (!this.hasSavedSyllabus || !this.syllabusContent) {
      return;
    }

    this.stopSpeakingQuestion();
    this.cleanupMicrophoneResources();
    this.resetAllItemAnswers();
    this.questionsError = null;
    this.answerError = null;
    this.voiceError = null;
    this.hasImageError = false;
    this.isLoadingImage = true;
    this.isGeneratingQuestions = true;
    this.questions = [];
    this.personalQuestions = [];
    this.revealedPersonalMap = {};
    this.vocabulary = [];
    this.selectedVocabIndex = 0;
    this.isVocabVisible = false;

    const randomSituationUrl = this.photoExamService.generateRandomImageUrl();
    this.imageUrl = randomSituationUrl;
    this.displayImageUrl = randomSituationUrl;
    this.imageBase64 = undefined;
    this.imageMimeType = undefined;

    try {
      const generated = await this.photoExamService.generateQuestions(
        this.syllabusContent,
        this.displayImageUrl
      );

      this.questions = generated.questions;
      this.personalQuestions = generated.personalQuestions;
      this.revealedPersonalMap = {};
      this.vocabulary = generated.vocabulary;
      this.selectedVocabIndex = 0;

      for (let i = 0; i < this.personalQuestions.length; i++) {
        this.getItemState(this.getPersonalKey(i));
      }

      this.photoExamService.setActiveSession({
        sessionKey: `practice-${Date.now()}`,
        syllabusContent: this.syllabusContent,
        imageUrl: this.imageUrl,
        resolvedImageUrl: this.displayImageUrl,
        questions: this.questions,
        personalQuestions: this.personalQuestions,
        vocabulary: this.vocabulary,
        userAnswer: '',
        feedback: null,
        savedPracticeId: null,
        savedCreatedAt: null,
      });
    } catch (error: unknown) {
      this.questionsError =
        error instanceof Error
          ? error.message
          : 'No se pudieron generar las preguntas. Inténtalo nuevamente.';
    } finally {
      this.isGeneratingQuestions = false;
    }
  }

  public async retryGenerateQuestions(): Promise<void> {
    if (this.isGeneratingQuestions || !this.displayImageUrl || !this.syllabusContent) {
      return;
    }

    this.questionsError = null;
    this.isGeneratingQuestions = true;

    try {
      const generated = await this.photoExamService.generateQuestions(
        this.syllabusContent,
        this.displayImageUrl,
        this.imageBase64,
        this.imageMimeType
      );
      this.questions = generated.questions;
      this.personalQuestions = generated.personalQuestions;
      this.revealedPersonalMap = {};
      this.vocabulary = generated.vocabulary;
      this.selectedVocabIndex = 0;

      for (let i = 0; i < this.personalQuestions.length; i++) {
        this.getItemState(this.getPersonalKey(i));
      }

      this.photoExamService.setActiveSession({
        sessionKey: `practice-${Date.now()}`,
        syllabusContent: this.syllabusContent,
        imageUrl: this.imageUrl,
        resolvedImageUrl: this.displayImageUrl,
        imageBase64: this.imageBase64,
        imageMimeType: this.imageMimeType,
        questions: this.questions,
        personalQuestions: this.personalQuestions,
        vocabulary: this.vocabulary,
        userAnswer: '',
        feedback: null,
        savedPracticeId: null,
        savedCreatedAt: null,
      });
    } catch (error: unknown) {
      this.questionsError =
        error instanceof Error
          ? error.message
          : 'No se pudieron generar las preguntas.';
    } finally {
      this.isGeneratingQuestions = false;
    }
  }

  // ============================================================================
  // GRABACIÓN DE AUDIO INDIVIDUAL POR PREGUNTA / SECCIÓN
  // ============================================================================

  public async toggleItemRecording(key: string): Promise<void> {
    if (this.isRecordingAudio && this.activeRecordingKey === key) {
      this.stopVoiceRecording();
    } else {
      await this.startVoiceRecording(key);
    }
  }

  public async startVoiceRecording(key: string): Promise<void> {
    const state = this.getItemState(key);
    if (
      this.isRecordingAudio ||
      this.isProcessingAudio ||
      this.isGeneratingQuestions ||
      this.isSubmittingAnswer ||
      state.audioBlob !== null
    ) {
      return;
    }

    this.stopSpeakingQuestion();
    this.voiceError = null;
    this.answerError = null;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.voiceError =
        'Tu navegador no permite el acceso al micrófono. Asegúrate de abrir la aplicación mediante HTTPS.';
      return;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];
      this.activeRecordingKey = key;

      const supportedMimeType = this.getSupportedAudioMimeType();
      try {
        this.mediaRecorder = supportedMimeType
          ? new MediaRecorder(this.mediaStream, {
              mimeType: supportedMimeType,
              audioBitsPerSecond: 32000,
            })
          : new MediaRecorder(this.mediaStream, { audioBitsPerSecond: 32000 });
      } catch {
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
      }

      this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      const targetKey = key;
      this.mediaRecorder.onstop = () => {
        this.handleRecordingStopped(targetKey);
      };

      this.mediaRecorder.start();
      this.isRecordingAudio = true;
      this.recordingSeconds = 0;

      this.recordingTimerId = setInterval(() => {
        this.recordingSeconds += 1;
      }, 1000);
    } catch {
      this.voiceError =
        'No se pudo acceder al micrófono. Verifica que el permiso del micrófono esté activado en tu navegador.';
      this.cleanupMicrophoneResources();
    }
  }

  public stopVoiceRecording(): void {
    if (!this.isRecordingAudio || !this.mediaRecorder) {
      return;
    }

    this.isRecordingAudio = false;
    this.isProcessingAudio = true;
    this.processingAudioKey = this.activeRecordingKey;

    if (this.recordingTimerId) {
      clearInterval(this.recordingTimerId);
      this.recordingTimerId = null;
    }

    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    } else {
      this.isProcessingAudio = false;
      this.processingAudioKey = null;
      this.activeRecordingKey = null;
    }

    this.stopMediaTracks();
  }

  private handleRecordingStopped(key: string): void {
    try {
      if (this.audioChunks.length === 0) {
        return;
      }

      const mimeType = this.mediaRecorder?.mimeType || 'audio/mp4';
      const audioBlob = new Blob(this.audioChunks, { type: mimeType });
      const state = this.getItemState(key);

      if (state.audioUrl) {
        URL.revokeObjectURL(state.audioUrl);
      }

      state.audioBlob = audioBlob;
      state.audioUrl = URL.createObjectURL(audioBlob);
      this.voiceError = null;
      this.answerError = null;
    } finally {
      this.isProcessingAudio = false;
      this.processingAudioKey = null;
      this.activeRecordingKey = null;
    }
  }

  public get formattedRecordingTime(): string {
    const mins = Math.floor(this.recordingSeconds / 60)
      .toString()
      .padStart(2, '0');
    const secs = (this.recordingSeconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  private getSupportedAudioMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
      return '';
    }
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  private stopMediaTracks(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private cleanupMicrophoneResources(): void {
    if (this.recordingTimerId) {
      clearInterval(this.recordingTimerId);
      this.recordingTimerId = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignorar si ya estaba inactivo
      }
    }
    this.isRecordingAudio = false;
    this.isProcessingAudio = false;
    this.activeRecordingKey = null;
    this.processingAudioKey = null;
    this.stopMediaTracks();
  }

  public onImageWillLoad(): void {
    this.isLoadingImage = true;
    this.hasImageError = false;
  }

  public onImageDidLoad(): void {
    this.isLoadingImage = false;
    this.hasImageError = false;
  }

  public onImageError(): void {
    this.isLoadingImage = false;
    this.hasImageError = true;
  }

  // ============================================================================
  // ENVÍO UNIFICADO ("ENVIAR TODO JUNTO")
  // ============================================================================

  public async onSubmitAnswer(): Promise<void> {
    if (
      this.isSubmittingAnswer ||
      this.isGeneratingQuestions ||
      this.isRecordingAudio ||
      this.isProcessingAudio ||
      this.questions.length === 0
    ) {
      return;
    }

    this.answerError = null;
    this.voiceError = null;

    if (!this.hasAnyAnswer) {
      this.answerError =
        'Todavía no has respondido ninguna parte. Graba un audio o escribe tu respuesta en la imagen o en las preguntas personales antes de enviar todo junto.';
      return;
    }

    const audioParts: Array<{ label: string; blob: Blob }> = [];
    const writtenSections: string[] = [];

    // 1) Talk about the picture
    const pictureState = this.getItemState('picture');
    if (pictureState.audioBlob && pictureState.audioBlob.size > 0) {
      audioParts.push({
        label: '1) Talk about the picture (Descripción oral de la foto)',
        blob: pictureState.audioBlob,
      });
    }
    if (pictureState.text.trim()) {
      writtenSections.push(
        `1) Talk about the picture (Respuesta escrita):\n${pictureState.text.trim()}`
      );
    }

    // 2) Answer these questions (una por una)
    for (let i = 0; i < this.personalQuestions.length; i++) {
      const key = this.getPersonalKey(i);
      const qState = this.getItemState(key);
      const qText = this.personalQuestions[i];

      if (qState.audioBlob && qState.audioBlob.size > 0) {
        audioParts.push({
          label: `2) Personal Question ${i + 1} (${qText})`,
          blob: qState.audioBlob,
        });
      }
      if (qState.text.trim()) {
        writtenSections.push(
          `2) Personal Question ${i + 1} (${qText}) - Respuesta escrita:\n${qState.text.trim()}`
        );
      }
    }

    const combinedWrittenAnswer = writtenSections.join('\n\n');
    const combinedQuestionsForEvaluation = [
      ...this.questions.map((q) => `[Picture Guide] ${q}`),
      ...this.personalQuestions.map((q, idx) => `[Personal Question ${idx + 1}] ${q}`),
    ];

    this.isSubmittingAnswer = true;

    try {
      this.photoExamService.setActiveSession({
        sessionKey:
          this.photoExamService.activeSession()?.sessionKey || `practice-${Date.now()}`,
        syllabusContent: this.syllabusContent,
        imageUrl: this.imageUrl,
        resolvedImageUrl: this.displayImageUrl,
        imageBase64: this.imageBase64,
        imageMimeType: this.imageMimeType,
        questions: [...this.questions],
        personalQuestions: [...this.personalQuestions],
        vocabulary: [...this.vocabulary],
        userAnswer:
          combinedWrittenAnswer ||
          `[Respuestas orales enviadas: ${audioParts.length} audio(s)]`,
        feedback: null,
        savedPracticeId: null,
        savedCreatedAt: null,
      });

      const feedback = await this.photoExamService.evaluateAnswer({
        syllabusContent: this.syllabusContent,
        imageUrl: this.displayImageUrl || this.imageUrl,
        questions: combinedQuestionsForEvaluation,
        userAnswer: combinedWrittenAnswer,
        audioParts,
      });

      const finalAnswerText = [
        feedback.transcript?.trim() ? feedback.transcript.trim() : '',
        combinedWrittenAnswer,
      ]
        .filter(Boolean)
        .join('\n\n');

      this.photoExamService.updateActiveSession({
        userAnswer: finalAnswerText || '[Respuesta oral evaluada por audio]',
        feedback,
      });

      await this.router.navigate(['/feedback']);
    } catch (error: unknown) {
      this.answerError =
        error instanceof Error
          ? error.message
          : 'No se pudo evaluar tu respuesta en este momento. Tus audios y textos siguen guardados: pulsa "Enviar todo junto" para reintentar.';
    } finally {
      this.isSubmittingAnswer = false;
    }
  }

  public goToSyllabus(): void {
    void this.router.navigate(['/syllabus']);
  }
}
