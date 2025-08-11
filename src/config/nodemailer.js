import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASSWORD;

if (!host || !user || !pass) {
  // Do not throw on import; services that send will validate later.
  // This allows the app to boot even if email is not configured in some envs.
  console.warn("[mail] SMTP credentials not fully configured");
}

export const mailTransport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: user && pass ? { user, pass } : undefined,
});

export async function verifyMailTransport() {
  try {
    await mailTransport.verify();
    return true;
  } catch (e) {
    console.warn("[mail] transport verify failed:", e.message);
    return false;
  }
}