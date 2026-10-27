import { Component, OnInit, inject } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
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
  IonSpinner,
  IonIcon,
  IonBadge,
  ViewWillEnter,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  bookOutline,
  cameraOutline,
  checkmarkCircleOutline,
  alertCircleOutline,
  sparklesOutline,
  bulbOutline,
  closeCircleOutline,
  cloudDoneOutline,
  cloudOfflineOutline,
  refreshOutline,
  timeOutline,
  chatbubbleEllipsesOutline,
} from 'ionicons/icons';
import {
  ActivePracticeSession,
  AiFeedback,
  PracticeRecord,
} from '../../models/photo-exam.models';
import { PhotoExamService } from '../../services/photo-exam.service';

@Component({
  selector: 'app-feedback',
  templateUrl: './feedback.page.html',
  styleUrls: ['./feedback.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    DatePipe,
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
    IonSpinner,
    IonIcon,
    IonBadge,
  ],
})
export class FeedbackPage implements OnInit, ViewWillEnter {
  public readonly photoExamService = inject(PhotoExamService);
  private readonly router = inject(Router);

  public session: ActivePracticeSession | null = null;
  public feedback: AiFeedback | null = null;

  // Estados diferenciados: Corrección generada vs Práctica guardada en Supabase (Requisito 7.3)
  public isFeedbackReady = false;
  public isSavingPractice = false;
  public isPracticeSaved = false;
  public saveSuccessMessage: string | null = null;
  public saveErrorMessage: string | null = null;

  // Historial reciente de prácticas en Supabase
  public recentPractices: PracticeRecord[] = [];
  public isLoadingHistory = false;

  constructor() {
    addIcons({
      bookOutline,
      cameraOutline,
      checkmarkCircleOutline,
      alertCircleOutline,
      sparklesOutline,
      bulbOutline,
      closeCircleOutline,
      cloudDoneOutline,
      cloudOfflineOutline,
      refreshOutline,
      timeOutline,
      chatbubbleEllipsesOutline,
    });
  }

  public ngOnInit(): void {
    void this.loadFeedbackAndPersist();
  }

  public ionViewWillEnter(): void {
    void this.loadFeedbackAndPersist();
  }

  /**
   * Carga la sesión evaluada y la guarda en Supabase si aún no fue persistida.
   * Evita duplicados gracias al control de `savedPracticeId`.
   */
  public async loadFeedbackAndPersist(): Promise<void> {
    const active = this.photoExamService.activeSession();

    if (active && active.feedback) {
      this.session = active;
      this.feedback = active.feedback;
      this.isFeedbackReady = true;

      if (active.savedPracticeId) {
        this.isPracticeSaved = true;
        this.saveErrorMessage = null;
        this.saveSuccessMessage =
          'Esta práctica ya se encuentra guardada en tu historial de Supabase.';
      } else {
        await this.persistCurrentPractice();
      }
    } else {
      this.session = null;
      this.feedback = null;
      this.isFeedbackReady = false;
    }

    await this.loadHistory();
  }

  /**
   * Guarda la práctica en Supabase y actualiza los indicadores de estado.
   */
  public async persistCurrentPractice(): Promise<void> {
    if (this.isSavingPractice || !this.session || !this.feedback) {
      return;
    }

    if (this.session.savedPracticeId) {
      this.isPracticeSaved = true;
      return;
    }

    this.isSavingPractice = true;
    this.saveErrorMessage = null;
    this.saveSuccessMessage = null;

    try {
      const saved = await this.photoExamService.saveCurrentPractice();
      this.session = this.photoExamService.activeSession();
      this.isPracticeSaved = true;
      this.saveSuccessMessage = `Práctica guardada correctamente en Supabase (${new Date(
        saved.created_at
      ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).`;
    } catch (error: unknown) {
      this.isPracticeSaved = false;
      this.saveErrorMessage =
        error instanceof Error
          ? error.message
          : 'No se pudo guardar la práctica en Supabase.';
    } finally {
      this.isSavingPractice = false;
    }
  }

  /**
   * Consulta el historial de prácticas guardadas por el estudiante.
   */
  public async loadHistory(): Promise<void> {
    if (this.isLoadingHistory) {
      return;
    }

    this.isLoadingHistory = true;
    try {
      this.recentPractices = await this.photoExamService.getPracticeHistory(6);
    } catch {
      // Si el historial no está disponible momentáneamente, no bloqueamos la vista principal
    } finally {
      this.isLoadingHistory = false;
    }
  }

  /**
   * Permite visualizar una práctica anterior del historial sin duplicar su registro.
   */
  public selectHistoryPractice(record: PracticeRecord): void {
    const syllabus =
      this.photoExamService.currentSyllabus()?.content ||
      this.session?.syllabusContent ||
      '';
    this.photoExamService.loadPracticeIntoFeedback(record, syllabus);
    this.session = this.photoExamService.activeSession();
    this.feedback = this.session?.feedback || null;
    this.isFeedbackReady = Boolean(this.feedback);
    this.isPracticeSaved = true;
    this.saveErrorMessage = null;
    this.saveSuccessMessage =
      'Visualizando práctica guardada previamente en tu historial de Supabase.';
  }

  /**
   * Limpia la práctica actual y navega a la pantalla de práctica para iniciar otra nueva.
   */
  public async startAnotherPractice(): Promise<void> {
    const currentSyllabus =
      this.photoExamService.currentSyllabus()?.content ||
      this.session?.syllabusContent ||
      '';

    // Reiniciamos la sesión activa para que PracticePage genere una nueva foto y preguntas
    this.photoExamService.setActiveSession({
      sessionKey: '',
      syllabusContent: currentSyllabus,
      imageUrl: '',
      questions: [],
      userAnswer: '',
      feedback: null,
      savedPracticeId: null,
      savedCreatedAt: null,
    });

    await this.router.navigate(['/practice']);
  }
}
