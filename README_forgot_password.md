## Auth workflow update: Forgot/Reset Password

This adds two endpoints and minor schema changes. Frontend integration details below.

### Summary of auth flow

- Registration: `POST /api/auth/register` → sends verification email.
- Verify email: `POST /api/auth/verify-email` with `{ token }`.
- Login: `POST /api/auth/login` with `{ email, password }` (requires verified email).
- Forgot password: `POST /api/auth/forgot-password` with `{ email }`.
- Reset password: `POST /api/auth/reset-password` with `{ token, password }`.

### Environment variables required

- `FRONTEND_URL` — base URL to construct verify/reset links (no trailing slash required).
- `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` — for transactional emails.

### Endpoints

1) Request reset link

POST `/api/auth/forgot-password`

Request body:

```json
{ "email": "user@example.com" }
```

Response (always 200 if request is valid):

```json
{ "message": "If an account exists for that email, a reset link has been sent." }
```

Notes:
- Always returns a generic success to avoid account enumeration.
- Email contains a link: `${FRONTEND_URL}/reset-password?token=...` valid for 1 hour.

2) Complete reset

POST `/api/auth/reset-password`

Request body:

```json
{ "token": "<token-from-email>", "password": "<newPasswordMin8Chars>" }
```

Responses:

- 200: `{ "message": "Password reset successful" }`
- 400: `{ "error": "Invalid or expired token" }` or `{ "error": "Invalid input" }`

### Frontend flows

1) Forgot Password page

- Form: email field, basic validation.
- Submit to `/api/auth/forgot-password`.
- Show success toast regardless of account existence.

2) Reset Password page

- Parse `token` from query string.
- Form: password field (min 8), confirm password client-side.
- Submit `{ token, password }` to `/api/auth/reset-password`.
- On success, redirect to login with success toast.

### UI copy suggestions

- Forgot: "If an account exists for that email, you'll receive a reset link shortly."
- Reset success: "Your password has been reset. Please sign in with your new password."

### Existing endpoints recap

- `POST /api/auth/register` → `{ email, password }`
- `POST /api/auth/verify-email` → `{ token }`
- `POST /api/auth/login` → `{ email, password }` ⇒ `{ token }`
- `POST /api/auth/logout` → `{ message }`

### Error handling

- All routes return JSON with either `{ message }` or `{ error }`.
- HTTP status codes used: 200, 400, 403, 500.

