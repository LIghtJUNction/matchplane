"use client";

import { LoginScreen } from "../../src/components/LoginScreen";

/** Public buyer/seller registration stays separate from the compact sign-in surface. */
export default function RegisterPage() {
  return <LoginScreen intent="sign-up" />;
}
