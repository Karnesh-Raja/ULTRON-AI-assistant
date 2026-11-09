"use client";

import { signIn } from "next-auth/react";

export default function SignInScreen() {
  return (
    <main className="signin-screen">
      <section className="signin-card">
        <div className="signin-mark" aria-hidden="true">U</div>
        <p className="signin-eyebrow">PERSONAL AI SYSTEM</p>
        <h1>ULTRON</h1>
        <p className="signin-copy">Sign in with your approved Google account to continue.</p>
        <button className="signin-button" type="button" onClick={() => void signIn("google", { callbackUrl: "/" })}>
          CONTINUE WITH GOOGLE
        </button>
        <p className="signin-privacy">When you ask ULTRON to use Gmail or Calendar, relevant results may be sent to Gemini to answer your request. Sending email and creating calendar events always require your confirmation.</p>
      </section>
    </main>
  );
}
