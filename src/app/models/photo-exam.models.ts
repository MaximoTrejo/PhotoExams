/**
 * Interfaces y modelos TypeScript fuertemente tipados para PhotoExams.
 */

export interface SyllabusRecord {
  id: string;
  content: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface SyllabusUpsertPayload {
  user_id: string;
  content: string;
  updated_at?: string;
}

export interface FeedbackErrorItem {
  original: string;
  corrected: string;
  explanation: string;
}

export interface FeedbackSuggestionItem {
  advice: string;
  example?: string;
}

export interface AiFeedback {
  hasErrors: boolean;
  noErrorsMessage: string;
  errores: FeedbackErrorItem[];
  aciertos: string[];
  sugerencias: FeedbackSuggestionItem[];
  rawMarkdown?: string;
}

export interface PracticeRecord {
  id: string;
  user_id: string;
  image_url: string;
  generated_questions: string[];
  user_answer: string;
  ai_feedback: string;
  created_at: string;
}

export interface PracticeInsertPayload {
  user_id: string;
  image_url: string;
  generated_questions: string[];
  user_answer: string;
  ai_feedback: string;
}

export interface GenerateQuestionsResponse {
  questions: string[];
  modelUsed?: string;
}

export interface EvaluateAnswerResponse {
  feedback: AiFeedback;
  modelUsed?: string;
}

export interface TranscribeAudioResponse {
  transcript: string;
  modelUsed?: string;
}

export interface ActivePracticeSession {
  sessionKey: string;
  syllabusContent: string;
  imageUrl: string;
  resolvedImageUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
  questions: string[];
  userAnswer: string;
  feedback: AiFeedback | null;
  savedPracticeId: string | null;
  savedCreatedAt: string | null;
}

export interface AuthUserState {
  id: string;
  email: string | null;
  isAnonymous: boolean;
}
