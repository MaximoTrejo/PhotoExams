import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'syllabus',
    pathMatch: 'full',
  },
  {
    path: 'syllabus',
    title: 'Mi resumen de inglés | PhotoExams',
    loadComponent: () =>
      import('./pages/syllabus/syllabus.page').then((m) => m.SyllabusPage),
  },
  {
    path: 'practice',
    title: 'Práctica Oral | PhotoExams',
    loadComponent: () =>
      import('./pages/practice/practice.page').then((m) => m.PracticePage),
  },
  {
    path: 'feedback',
    title: 'Retroalimentación | PhotoExams',
    loadComponent: () =>
      import('./pages/feedback/feedback.page').then((m) => m.FeedbackPage),
  },
  {
    path: '**',
    redirectTo: 'syllabus',
  },
];
