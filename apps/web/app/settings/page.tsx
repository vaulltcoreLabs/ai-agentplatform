import type { Metadata } from "@/lib/metadata";
import { redirect } from "@/lib/navigation";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your Vaulltcore account settings.",
};

export default function SettingsPage() {
  redirect("/settings/profile");
}
