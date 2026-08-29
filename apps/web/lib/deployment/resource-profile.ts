export type VaulltcoreResourceProfile = "standard" | "hobby";

export function getVaulltcoreResourceProfile(): VaulltcoreResourceProfile {
  return process.env.VAULLTCORE_RESOURCE_PROFILE === "hobby"
    ? "hobby"
    : "standard";
}

export function isHobbyResourceProfile(): boolean {
  return getVaulltcoreResourceProfile() === "hobby";
}
