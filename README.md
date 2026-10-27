# PhotoExams — Práctica de Exámenes Orales de Inglés con IA

Aplicación desarrollada con **Ionic Framework**, **Angular (Standalone Components)**, **TypeScript**, **Supabase (PostgreSQL + RLS + Edge Functions)** y **Google Gemini API** para practicar exámenes orales de inglés mediante la descripción de fotografías cotidianas y recibir retroalimentación constructiva basada en los apuntes del estudiante.

---

## 1. Estructura de carpetas del proyecto

```text
PhotoExams/
├── .env.example
├── .gitignore
├── README.md
├── angular.json
├── ionic.config.json
├── package.json
├── tsconfig.app.json
├── tsconfig.json
├── supabase/
│   ├── schema.sql
│   └── functions/
│       └── gemini-exam/
│           └── index.ts
└── src/
    ├── index.html
    ├── main.ts
    ├── global.scss
    ├── assets/
    │   └── .gitkeep
    ├── theme/
    │   └── variables.scss
    ├── environments/
    │   ├── environment.ts
    │   └── environment.prod.ts
    └── app/
        ├── app.component.ts
        ├── app.component.html
        ├── app.component.scss
        ├── app.routes.ts
        ├── models/
        │   └── photo-exam.models.ts
        ├── services/
        │   └── photo-exam.service.ts
        └── pages/
            ├── syllabus/
            │   ├── syllabus.page.ts
            │   ├── syllabus.page.html
            │   └── syllabus.page.scss
            ├── practice/
            │   ├── practice.page.ts
            │   ├── practice.page.html
            │   └── practice.page.scss
            └── feedback/
                ├── feedback.page.ts
                ├── feedback.page.html
                └── feedback.page.scss
```

---

## 2. Instalación de dependencias

En la raíz del proyecto (`e:\Proyectos\PhotoExams`), ejecuta:

```bash
npm install
```

Si deseas instalar globalmente las herramientas de línea de comandos de Ionic, Angular y Supabase:

```bash
npm install -g @ionic/cli @angular/cli supabase
```

---

## 3. Pasos para ejecutar el SQL en Supabase

1. Ingresa al panel de tu proyecto en [Supabase Dashboard](https://supabase.com/dashboard/project/mnidmbzfxzvijfsypqqi).
2. En el menú lateral izquierdo, selecciona **SQL Editor** y haz clic en **New query**.
3. Abre el archivo `supabase/schema.sql`, copia todo su contenido y pégalo en el editor SQL.
4. Haz clic en **Run** (`Ctrl + Enter`).
   - Se crearán las tablas `public.syllabus` (con restricción `UNIQUE (user_id)` para `UPSERT`) y `public.practices`.
   - Se crearán los índices y el trigger `trg_syllabus_updated_at`.
   - Se activará **Row Level Security (RLS)** y se crearán las políticas `SELECT`, `INSERT`, `UPDATE` y `DELETE` restringidas a `auth.uid() = user_id`.
5. En **Authentication** -> **Providers**, verifica que **Email** esté habilitado.
   - *(Opcional recomendado)* En **Authentication** -> **Settings**, activa **Enable anonymous sign-ins** para que la aplicación cree automáticamente una sesión autenticada con `auth.uid()` al abrirse, sin obligar al estudiante a registrarse manualmente antes de su primera prueba.

---

## 4. Configuración de secretos de Gemini y despliegue de la Edge Function

Por seguridad obligatoria, `GEMINI_API_KEY` **nunca** se incluye en el frontend (`src/environments/`). Las llamadas a la API de Google Gemini se realizan desde la Supabase Edge Function `supabase/functions/gemini-exam/index.ts`.

### Nota sobre el modelo `gemini-1.5-flash` y cambio a `gemini-3.8-flash`

Dado que `gemini-1.5-flash` (así como `gemini-2.0-flash`) ya fue retirado por Google AI Studio, la Edge Function utiliza el modelo compatible actual **`gemini-3.8-flash`** (o el valor definido en el secreto `GEMINI_MODEL`), además de detectar dinámicamente cualquier modelo nuevo sugerido por la API de Google en caso de futuras actualizaciones.

### Pasos con Supabase CLI (o desde el panel web en Edge Functions -> Secrets):

1. Inicia sesión en Supabase CLI y vincula el proyecto:

```bash
npx supabase login
npx supabase link --project-ref mnidmbzfxzvijfsypqqi
```

2. Configura tu clave privada de Google Gemini en los secretos del backend:

```bash
npx supabase secrets set GEMINI_API_KEY=TU_CLAVE_PRIVADA_DE_GEMINI
npx supabase secrets set GEMINI_MODEL=gemini-3.8-flash
```

3. Despliega la Edge Function `gemini-exam`:

```bash
npx supabase functions deploy gemini-exam
```

---

## 5. Ejecución y prueba de la aplicación

1. Inicia el servidor de desarrollo:

```bash
npm start
# o bien:
ionic serve
```

2. Abre `http://localhost:4200` en tu navegador.
3. **Flujo de prueba completo:**
   - **Pantalla 1 — Resumen (`/syllabus`):**
     - Si no tienes habilitado el inicio anónimo en Supabase, inicia sesión o crea una cuenta con tu correo y contraseña en el panel superior.
     - Pulsa **Cargar ejemplo** (o pega tus propios apuntes de inglés) y haz clic en **Guardar Resumen**. Verifica el mensaje de confirmación del `UPSERT` en Supabase.
   - **Pantalla 2 — Práctica (`/practice`):**
     - Haz clic en **Ir a Practicar**.
     - Se descargará una fotografía aleatoria de Picsum (`https://picsum.photos/800/600?random=X`) y, mientras Gemini genera las 5 preguntas basadas en la foto y tu resumen, verás los indicadores `ion-skeleton-text`.
     - Escribe tu respuesta en inglés en el área **Your answer** y pulsa **Enviar respuesta**.
   - **Pantalla 3 — Retroalimentación (`/feedback`):**
     - Observa los dos indicadores superiores: **Corrección generada correctamente** y **Práctica guardada correctamente** en Supabase.
     - Revisa las tres tarjetas diferenciadas: **Errores**, **Aciertos** y **Sugerencias**.
     - Recarga o vuelve a abrir la pestaña de corrección para comprobar que no se duplican los registros en `public.practices`.
