import JarvisOrb from "@/components/JarvisOrb";
import SignInScreen from "@/components/SignInScreen";
import { getSignedInEmail } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const email = await getSignedInEmail();
  return email ? <JarvisOrb userEmail={email} /> : <SignInScreen />;
}
