export interface AppEnvironment {
  production: boolean;
  supabaseUrl: string;
  supabasePublishableKey: string;
  geminiEdgeFunctionName: string;
}

/**
 * Configuración de entorno de desarrollo para Angular.
 * Adaptación de NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
 *
 * SEGURIDAD OBLIGATORIA:
 * La clave privada GEMINI_API_KEY NUNCA se define aquí ni se envía al navegador.
 * Se almacena únicamente en los secretos de Supabase Edge Functions.
 */
export const environment: AppEnvironment = {
  production: false,
  supabaseUrl: 'https://mnidmbzfxzvijfsypqqi.supabase.co',
  supabasePublishableKey: 'sb_publishable_YZPO5pDEsOvR07xQbZifMQ_EJd6zlmI',
  geminiEdgeFunctionName: 'gemini-exam',
};
