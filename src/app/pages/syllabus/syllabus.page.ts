import { Component, OnInit, inject } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
  IonTextarea,
  IonInput,
  IonItem,
  IonLabel,
  IonSpinner,
  IonIcon,
  IonBadge,
  IonSkeletonText,
  ViewWillEnter,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  bookOutline,
  saveOutline,
  checkmarkCircleOutline,
  alertCircleOutline,
  cameraOutline,
  sparklesOutline,
  personCircleOutline,
  logInOutline,
  logOutOutline,
  personAddOutline,
  documentTextOutline,
} from 'ionicons/icons';
import { PhotoExamService } from '../../services/photo-exam.service';

@Component({
  selector: 'app-syllabus',
  templateUrl: './syllabus.page.html',
  styleUrls: ['./syllabus.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
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
    IonTextarea,
    IonInput,
    IonItem,
    IonLabel,
    IonSpinner,
    IonIcon,
    IonBadge,
    IonSkeletonText,
  ],
})
export class SyllabusPage implements OnInit, ViewWillEnter {
  public readonly photoExamService = inject(PhotoExamService);
  private readonly router = inject(Router);

  public syllabusContent = '';
  public lastUpdatedAt: string | null = null;
  public isLoading = false;
  public isSaving = false;
  public statusMessage: string | null = null;
  public errorMessage: string | null = null;

  // Estado del formulario de autenticación (Email / Password) cuando se requiere sesión
  public showAuthForm = false;
  public authEmail = '';
  public authPassword = '';
  public isAuthLoading = false;
  public authErrorMessage: string | null = null;
  public authSuccessMessage: string | null = null;

  private readonly sampleSyllabus = `GRAMMAR TOPICS:
1. Present Continuous (am/is/are + verb-ing):
   - Used to describe actions happening right now in the photo.
   - Examples: "She is wearing a blue jacket", "They are walking in the street", "He is pointing at a building".

2. Simple Present:
   - Used for general facts, routines, and states.
   - Examples: "He looks happy", "The street has many shops".

3. Prepositions of Place:
   - in, on, at, next to, behind, in front of, between, on the left, on the right, in the background, in the foreground.

4. Physical Appearance & Clothes Vocabulary:
   - Height/Build: tall, short, medium height, slim, young, middle-aged.
   - Hair: long, short, straight, curly, wavy, dark, blonde, brown hair.
   - Clothes: shirt, t-shirt, jacket, coat, jeans, trousers, dress, glasses, backpack, hat.

5. Giving Directions & Advice (Modal Should / Imperatives):
   - go straight on, turn left, turn right, walk past, cross the street.
   - "He should take the first street on the left."

6. Future with "will" and "going to" (Predictions):
   - "I think they will go to a café next."
   - "She is going to take a photo."`;

  constructor() {
    addIcons({
      bookOutline,
      saveOutline,
      checkmarkCircleOutline,
      alertCircleOutline,
      cameraOutline,
      sparklesOutline,
      personCircleOutline,
      logInOutline,
      logOutOutline,
      personAddOutline,
      documentTextOutline,
    });
  }

  public ngOnInit(): void {
    void this.loadSavedSyllabus();
  }

  public ionViewWillEnter(): void {
    void this.loadSavedSyllabus();
  }

  /**
   * Recupera el resumen guardado desde Supabase al abrir la pantalla.
   */
  public async loadSavedSyllabus(): Promise<void> {
    if (this.isLoading) {
      return;
    }

    this.isLoading = true;
    this.errorMessage = null;

    try {
      const user = await this.photoExamService.ensureAuthenticatedUser();
      if (!user) {
        this.showAuthForm = true;
        return;
      }

      this.showAuthForm = false;
      const record = await this.photoExamService.getSyllabus();
      if (record) {
        this.syllabusContent = record.content;
        this.lastUpdatedAt = record.updated_at;
      }
    } catch (error: unknown) {
      this.errorMessage =
        error instanceof Error
          ? error.message
          : 'No se pudo cargar tu resumen desde Supabase.';
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Valida y guarda el resumen en Supabase mediante UPSERT.
   */
  public async onSaveSyllabus(): Promise<void> {
    if (this.isSaving) {
      return;
    }

    this.statusMessage = null;
    this.errorMessage = null;

    const trimmed = this.syllabusContent.trim();
    if (!trimmed) {
      this.errorMessage =
        'El resumen está vacío. Por favor, escribe o pega tus apuntes de gramática y vocabulario antes de guardarlo.';
      return;
    }

    this.isSaving = true;

    try {
      const saved = await this.photoExamService.saveSyllabus(trimmed);
      this.syllabusContent = saved.content;
      this.lastUpdatedAt = saved.updated_at;
      this.statusMessage =
        '¡Resumen guardado correctamente! Tus preguntas y correcciones se basarán en estos apuntes.';
    } catch (error: unknown) {
      if (!this.photoExamService.isAuthenticated()) {
        this.showAuthForm = true;
      }
      this.errorMessage =
        error instanceof Error
          ? error.message
          : 'No se pudo guardar el resumen en Supabase.';
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Carga un resumen de ejemplo escolar para facilitar las pruebas.
   */
  public loadSampleNotes(): void {
    this.syllabusContent = this.sampleSyllabus;
    this.errorMessage = null;
    this.statusMessage =
      'Se cargó un ejemplo de apuntes de inglés. Haz clic en "Guardar Resumen" para almacenarlo en Supabase.';
  }

  /**
   * Navega hacia la pantalla de práctica.
   */
  public goToPractice(): void {
    void this.router.navigate(['/practice']);
  }

  // ============================================================================
  // MÉTODOS DE AUTENTICACIÓN DE ESTUDIANTE (SUPABASE AUTH)
  // ============================================================================

  public toggleAuthPanel(): void {
    this.showAuthForm = !this.showAuthForm;
    this.authErrorMessage = null;
    this.authSuccessMessage = null;
  }

  public async onSignIn(): Promise<void> {
    if (this.isAuthLoading) {
      return;
    }
    this.isAuthLoading = true;
    this.authErrorMessage = null;
    this.authSuccessMessage = null;

    try {
      await this.photoExamService.signInWithEmail(this.authEmail, this.authPassword);
      this.authPassword = '';
      this.showAuthForm = false;
      this.authSuccessMessage = 'Sesión iniciada correctamente.';
      await this.loadSavedSyllabus();
    } catch (error: unknown) {
      this.authErrorMessage =
        error instanceof Error ? error.message : 'No se pudo iniciar sesión.';
    } finally {
      this.isAuthLoading = false;
    }
  }

  public async onSignUp(): Promise<void> {
    if (this.isAuthLoading) {
      return;
    }
    this.isAuthLoading = true;
    this.authErrorMessage = null;
    this.authSuccessMessage = null;

    try {
      const result = await this.photoExamService.signUpWithEmail(
        this.authEmail,
        this.authPassword
      );

      if (result.requiresEmailConfirmation) {
        this.showAuthForm = true;
        this.authSuccessMessage =
          'Cuenta creada. Confirma el enlace enviado a tu correo electrónico y luego haz clic en "Iniciar sesión".';
        return;
      }

      this.authPassword = '';
      this.showAuthForm = false;
      this.authSuccessMessage =
        'Cuenta creada correctamente. Ya puedes guardar tu resumen.';
      await this.loadSavedSyllabus();
    } catch (error: unknown) {
      this.authErrorMessage =
        error instanceof Error ? error.message : 'No se pudo registrar la cuenta.';
    } finally {
      this.isAuthLoading = false;
    }
  }

  public async onSignOut(): Promise<void> {
    await this.photoExamService.signOut();
    this.syllabusContent = '';
    this.lastUpdatedAt = null;
    this.statusMessage = null;
    this.showAuthForm = true;
  }
}
