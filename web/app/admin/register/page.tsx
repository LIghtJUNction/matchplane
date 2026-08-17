import { LoginScreen } from "../../../src/components/LoginScreen";

/**
 * CLI-generated administrator links land here, but the form is deliberately the
 * same account screen used by everyone. The invitation token is handled by the
 * client after Better Auth establishes the session; no administrator-only
 * credential flow is exposed in the UI.
 */
export default function AdminRegisterPage() {
  return <LoginScreen />;
}
