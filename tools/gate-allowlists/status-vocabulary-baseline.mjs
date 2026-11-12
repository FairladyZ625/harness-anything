// Frozen status-vocabulary declarations outside the kernel domain that are not yet
// owned by a declared state store (dec_499E4E98A3D4754132B3BCA1E6 CH1).
//
// A baseline entry is not an exemption: it freezes the current words of one
// declaration so the vocabulary cannot grow silently. Ownership is declared by
// registering the anchor with mirrorOf / ownerStore / scope: "view-local"; the
// entry then becomes stale and the gate refuses it until it is deleted.
export const statusVocabularyBaseline = Object.freeze([]);

// External status vocabularies that were registered before the ownership form became
// mandatory (dec_499E4E98A3D4754132B3BCA1E6 CH1). Owning one later makes its entry
// stale; a new external row without mirrorOf / ownerStore / view-local is refused.
export const statusVocabularyUnownedRegister = Object.freeze([]);
