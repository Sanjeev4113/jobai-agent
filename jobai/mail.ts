/** Send JobAI emails through Gmail (an app password, not your normal password). */
import nodemailer from "nodemailer";

export const TO = process.env.JOBAI_TO ?? "sanjeevsudarsanam@gmail.com";
export const hasMail = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

export async function send(subject: string, html: string, attachments: { filename: string; path: string }[] = []) {
  if (!hasMail()) {
    console.log(`[mail] (not configured) would send: ${subject} with ${attachments.length} attachment(s)`);
    return false;
  }
  const t = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: `JobAI <${process.env.GMAIL_USER}>`, to: TO, subject, html, attachments });
  return true;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
