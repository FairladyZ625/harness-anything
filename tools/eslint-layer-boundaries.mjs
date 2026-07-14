const applicationProjectionBoundaryMessage = "Application triadic/projection consumers must read facts from the projection, not kernel authored storage.";
const rendererStorageBoundaryMessage = "GUI renderer must not import kernel storage primitives; use the renderer bridge.";

export const eslintLayerBoundaries = Object.freeze({
  applicationTriadicProjection: Object.freeze({
    id: "application-triadic-projection-no-authored-store",
    files: Object.freeze([
      "packages/application/src/local-controller-service.ts"
    ]),
    restrictedImports: Object.freeze({
      patterns: Object.freeze([
        Object.freeze({
          group: Object.freeze([
            "@harness-anything/kernel",
            "@harness-anything/kernel/index.*",
            "**/kernel/src/index.*",
            "**/kernel/src/store/markdown-artifact-store.*"
          ]),
          importNames: Object.freeze(["ArtifactStore", "readAuthoredDocument"]),
          allowTypeImports: true,
          message: applicationProjectionBoundaryMessage
        })
      ])
    })
  }),
  rendererKernelStorage: Object.freeze({
    id: "renderer-no-kernel-storage-primitives",
    files: Object.freeze([
      "packages/gui/src/renderer/**/*.{ts,tsx,js,mjs}"
    ]),
    restrictedImports: Object.freeze({
      patterns: Object.freeze([
        Object.freeze({
          group: Object.freeze([
            "@harness-anything/kernel/store",
            "@harness-anything/kernel/store/**",
            "**/kernel/src/store",
            "**/kernel/src/store/**"
          ]),
          message: rendererStorageBoundaryMessage
        })
      ])
    })
  })
});

export const eslintLayerBoundaryMessages = Object.freeze({
  applicationTriadicProjection: applicationProjectionBoundaryMessage,
  rendererKernelStorage: rendererStorageBoundaryMessage
});
