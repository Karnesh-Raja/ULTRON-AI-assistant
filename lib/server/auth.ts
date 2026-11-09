import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";
import { storeGoogleConnection } from "@/lib/server/google";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events.owned",
].join(" ");

export const authOptions: NextAuthOptions = {
  providers: [GoogleProvider({
    clientId: process.env.AUTH_GOOGLE_ID ?? "",
    clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    authorization: { params: { scope: GOOGLE_SCOPES, access_type: "offline", prompt: "consent", include_granted_scopes: "true" } },
  })],
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/" },
  callbacks: {
    async signIn({ user, account }) {
      const allowlistedEmail = process.env.ULTRON_ALLOWED_EMAIL?.trim().toLowerCase();
      return account?.provider === "google" && Boolean(allowlistedEmail) && user.email?.trim().toLowerCase() === allowlistedEmail;
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google" || !account.providerAccountId) return;
      const googleProfile = profile as { email?: string } | undefined;
      const email = (googleProfile?.email ?? user.email)?.trim().toLowerCase();
      if (!email) return;
      await storeGoogleConnection({
        email,
        subject: account.providerAccountId,
        refreshToken: account.refresh_token,
        scopes: account.scope,
      });
    },
  },
};
