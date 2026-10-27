import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonHeader,
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
  IonList,
  IonItem,
  IonLabel,
  IonTextarea,
  IonSkeletonText,
  IonSpinner,
  IonIcon,
  IonBadge,
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
  helpCircleOutline,
  createOutline,
  imageOutline,
  arrowForwardOutline,
  sparklesOutline,
  micOutline,
  stopCircleOutline,
  volumeHighOutline,
  trashOutline,
  peopleOutline,
} from 'ionicons/icons';
import { PhotoExamService } from '../../services/photo-exam.service';

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
    IonList,
    IonItem,
    IonLabel,
    IonTextarea,
    IonSkeletonText,
    IonSpinner,
    IonIcon,
    IonBadge,
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
  public userAnswer = '';

  public isCheckingSyllabus = false;
  public isLoadingImage = false;
  public hasImageError = false;
  public isGeneratingQuestions = false;
  public isSubmittingAnswer = false;

  // Estados de grabación de respuesta oral (micrófono en móvil y escritorio)
  public isRecordingAudio = false;
  public isTranscribingAudio = false;
  public recordingSeconds = 0;
  public recordedAudioUrl: string | null = null;
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
      helpCircleOutline,
      createOutline,
      imageOutline,
      arrowForwardOutline,
      sparklesOutline,
      micOutline,
      stopCircleOutline,
      volumeHighOutline,
      trashOutline,
      peopleOutline,
    });
  }

  public ngOnInit(): void {
    void this.initializePracticeScreen(false);
  }

  public ionViewWillEnter(): void {
    void this.initializePracticeScreen(false);
  }

  public ionViewWillLeave(): void {
    this.cleanupMicrophoneResources();
  }

  public ngOnDestroy(): void {
    this.cleanupMicrophoneResources();
    if (this.recordedAudioUrl) {
      URL.revokeObjectURL(this.recordedAudioUrl);
    }
  }

  /**
   * 6.2. Al cargar la pantalla:
   * 1. Recupera el resumen del estudiante desde Supabase.
   * 2. Comprueba que exista un resumen guardado.
   * 3. Si ya hay una práctica en curso con ese resumen, la restaura; si no, inicia una nueva.
   */
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
        this.userAnswer = existingSession.userAnswer;
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

  /**
   * Solicita confirmación si el estudiante ya escribió o grabó parte de su respuesta
   * antes de generar otra fotografía y comenzar una nueva práctica.
   */
  public async onRequestNewPractice(): Promise<void> {
    if (this.isGeneratingQuestions || this.isSubmittingAnswer || this.isRecordingAudio) {
      return;
    }

    if (this.userAnswer.trim().length > 0) {
      const alert = await this.alertController.create({
        header: '¿Comenzar nueva práctica?',
        message:
          'Tienes una respuesta en curso. Si generas otra fotografía ahora, se reemplazará la respuesta actual.',
        buttons: [
          {
            text: 'Cancelar',
            role: 'cancel',
          },
          {
            text: 'Nueva práctica',
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

  /**
   * Carga una nueva imagen de personas en situaciones cotidianas y genera las 5 preguntas con Gemini.
   */
  public async startNewPracticeSession(): Promise<void> {
    if (!this.hasSavedSyllabus || !this.syllabusContent) {
      return;
    }

    this.cleanupMicrophoneResources();
    this.clearAudioRecording();
    this.questionsError = null;
    this.answerError = null;
    this.voiceError = null;
    this.hasImageError = false;
    this.isLoadingImage = true;
    this.isGeneratingQuestions = true;
    this.questions = [];
    this.userAnswer = '';

    const randomSituationUrl = this.photoExamService.generateRandomImageUrl();
    this.imageUrl = randomSituationUrl;
    this.displayImageUrl = randomSituationUrl;
    this.imageBase64 = undefined;
    this.imageMimeType = undefined;

    try {
      const preloaded = await this.photoExamService.preloadPracticeImage(randomSituationUrl);
      this.displayImageUrl = preloaded.resolvedUrl;
      this.imageBase64 = preloaded.base64;
      this.imageMimeType = preloaded.mimeType;

      const generatedQuestions = await this.photoExamService.generateQuestions(
        this.syllabusContent,
        this.displayImageUrl,
        this.imageBase64,
        this.imageMimeType
      );

      this.questions = generatedQuestions;

      this.photoExamService.setActiveSession({
        sessionKey: `practice-${Date.now()}`,
        syllabusContent: this.syllabusContent,
        imageUrl: this.imageUrl,
        resolvedImageUrl: this.displayImageUrl,
        imageBase64: this.imageBase64,
        imageMimeType: this.imageMimeType,
        questions: this.questions,
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

  /**
   * Reintenta únicamente la generación de preguntas conservando la imagen actual.
   */
  public async retryGenerateQuestions(): Promise<void> {
    if (this.isGeneratingQuestions || !this.displayImageUrl || !this.syllabusContent) {
      return;
    }

    this.questionsError = null;
    this.isGeneratingQuestions = true;

    try {
      const generatedQuestions = await this.photoExamService.generateQuestions(
        this.syllabusContent,
        this.displayImageUrl,
        this.imageBase64,
        this.imageMimeType
      );
      this.questions = generatedQuestions;

      this.photoExamService.setActiveSession({
        sessionKey: `practice-${Date.now()}`,
        syllabusContent: this.syllabusContent,
        imageUrl: this.imageUrl,
        resolvedImageUrl: this.displayImageUrl,
        imageBase64: this.imageBase64,
        imageMimeType: this.imageMimeType,
        questions: this.questions,
        userAnswer: this.userAnswer,
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
  // RESPUESTA ORAL POR VOZ (MICRÓFONO EN NAVEGADOR MÓVIL / VERCEL HTTPS)
  // ============================================================================

  public async toggleVoiceRecording(): Promise<void> {
    if (this.isRecordingAudio) {
      this.stopVoiceRecording();
    } else {
      await this.startVoiceRecording();
    }
  }

  public async startVoiceRecording(): Promise<void> {
    if (
      this.isRecordingAudio ||
      this.isTranscribingAudio ||
      this.isGeneratingQuestions ||
      this.isSubmittingAnswer
    ) {
      return;
    }

    this.voiceError = null;
    this.answerError = null;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.voiceError =
        'Tu navegador no permite el acceso al micrófono. Asegúrate de abrir la aplicación mediante HTTPS (por ejemplo, en Vercel).';
      return;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      const supportedMimeType = this.getSupportedAudioMimeType();
      this.mediaRecorder = supportedMimeType
        ? new MediaRecorder(this.mediaStream, { mimeType: supportedMimeType })
        : new MediaRecorder(this.mediaStream);

      this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        void this.handleRecordingStopped();
      };

      this.mediaRecorder.start();
      this.isRecordingAudio = true;
      this.recordingSeconds = 0;

      this.recordingTimerId = setInterval(() => {
        this.recordingSeconds += 1;
      }, 1000);
    } catch {
      this.voiceError =
        'No se pudo acceder al micrófono. Permite el permiso de micrófono en tu navegador móvil e inténtalo de nuevo.';
      this.cleanupMicrophoneResources();
    }
  }

  public stopVoiceRecording(): void {
    if (!this.isRecordingAudio || !this.mediaRecorder) {
      return;
    }

    this.isRecordingAudio = false;
    if (this.recordingTimerId) {
      clearInterval(this.recordingTimerId);
      this.recordingTimerId = null;
    }

    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    this.stopMediaTracks();
  }

  private async handleRecordingStopped(): Promise<void> {
    if (this.audioChunks.length === 0) {
      return;
    }

    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    const audioBlob = new Blob(this.audioChunks, { type: mimeType });

    if (this.recordedAudioUrl) {
      URL.revokeObjectURL(this.recordedAudioUrl);
    }
    this.recordedAudioUrl = URL.createObjectURL(audioBlob);

    this.isTranscribingAudio = true;
    this.voiceError = null;

    try {
      const transcript = await this.photoExamService.transcribeAudio(audioBlob);
      const currentText = this.userAnswer.trim();
      const updatedText = currentText ? `${currentText} ${transcript}` : transcript;
      this.onAnswerChange(updatedText);
    } catch (error: unknown) {
      this.voiceError =
        error instanceof Error
          ? error.message
          : 'No se pudo transcribir el audio. Intenta hablar un poco más cerca del micrófono.';
    } finally {
      this.isTranscribingAudio = false;
    }
  }

  public clearAudioRecording(): void {
    if (this.recordedAudioUrl) {
      URL.revokeObjectURL(this.recordedAudioUrl);
      this.recordedAudioUrl = null;
    }
    this.audioChunks = [];
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
        // Ignorar si ya se detuvo
      }
    }
    this.isRecordingAudio = false;
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

  public onAnswerChange(value: string): void {
    this.userAnswer = value;
    if (this.answerError && value.trim().length > 0) {
      this.answerError = null;
    }
    this.photoExamService.updateActiveSession({ userAnswer: value });
  }

  /**
   * 6.5. Envía la respuesta del estudiante a Gemini para su evaluación y navega a Feedback.
   */
  public async onSubmitAnswer(): Promise<void> {
    if (
      this.isSubmittingAnswer ||
      this.isGeneratingQuestions ||
      this.isRecordingAudio ||
      this.isTranscribingAudio ||
      this.questions.length === 0
    ) {
      return;
    }

    this.answerError = null;
    const trimmedAnswer = this.userAnswer.trim();

    if (!trimmedAnswer) {
      this.answerError =
        'Tu respuesta está vacía. Puedes hablar con el micrófono o escribir tu respuesta en inglés antes de enviar.';
      return;
    }

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
        userAnswer: trimmedAnswer,
        feedback: null,
        savedPracticeId: null,
        savedCreatedAt: null,
      });

      const feedback = await this.photoExamService.evaluateAnswer({
        syllabusContent: this.syllabusContent,
        imageUrl: this.displayImageUrl || this.imageUrl,
        questions: this.questions,
        userAnswer: trimmedAnswer,
        imageBase64: this.imageBase64,
        imageMimeType: this.imageMimeType,
      });

      this.photoExamService.updateActiveSession({
        userAnswer: trimmedAnswer,
        feedback,
      });

      await this.router.navigate(['/feedback']);
    } catch (error: unknown) {
      this.answerError =
        error instanceof Error
          ? error.message
          : 'No se pudo evaluar tu respuesta en este momento. Por favor, inténtalo de nuevo.';
    } finally {
      this.isSubmittingAnswer = false;
    }
  }

  public goToSyllabus(): void {
    void this.router.navigate(['/syllabus']);
  }
}
