export { platformQualificationMatrix } from "./matrix.ts";
export {
  draftPlatformMetadataPolicy,
  metadataPolicyFields,
  validatePlatformMetadataPolicy,
  type MetadataFieldDisposition,
  type MetadataPolicyValidation,
  type PlatformMetadataPolicy
} from "./metadata-policy.ts";
export {
  observeRuntimeMount,
  parseDarwinMountOutput,
  parseLinuxMountInfo,
  selectMountForPath
} from "./mount-observation.ts";
export { qualifyWritablePlatform, type PlatformQualificationOptions } from "./qualification.ts";
export {
  probePortableFileSemantics,
  unboundNativeSemanticProbes,
  type NativeSemanticProbe
} from "./semantic-probe.ts";
export {
  platformCapabilityNames,
  platformQualificationExitCodes,
  type CapabilityProbeResult,
  type MountObservation,
  type PlatformAdapterDeclaration,
  type PlatformAdapterId,
  type PlatformCapabilityDeclaration,
  type PlatformCapabilityName,
  type PlatformKind,
  type PlatformQualificationExitSymbol,
  type PlatformQualificationFailure,
  type PlatformQualificationResult,
  type PlatformRuntimeObservation,
  type WritableQualification
} from "./types.ts";
export { deriveWslViewId, detectWsl, type WslDetection, type WslDetectionInput, type WslViewIdentityInput } from "./wsl.ts";
