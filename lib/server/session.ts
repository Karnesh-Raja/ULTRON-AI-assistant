import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/server/auth";

export async function getSignedInEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email?.trim().toLowerCase();
  const allowedEmail = process.env.ULTRON_ALLOWED_EMAIL?.trim().toLowerCase();
  return email && allowedEmail && email === allowedEmail ? email : null;
}
