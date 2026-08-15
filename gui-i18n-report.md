# GUI 中文界面补全报告

基线：`f6758ac5`；工作分支：`codex/gui-i18n`；工作目录：`/Users/lizeyu/Projects/coding-agent-harness/harness-anything/.worktrees/gui-i18n`。

本报告只覆盖 renderer 文案、locale，以及 line-budget ceiling 上调所必需的 gate fixture/接线。Preset 卡片的 `preset.title`、`preset.description`、`vertical.title` 等来自 bundled preset 数据定义，不是 UI 文案，本包未修改。

## 类型 A：硬编码 UI 文案抽取

精确口径：以基线到当前 diff 中新增的固定 `t("…")` 调用点计处数；同一文案在不同渲染分支/重复展示处分别计数，key 在同一文件单元格内合并并标注重复次数。共 **566 个 call site、515 个 unique key、25 个 renderer 文件**。CEO 的 63/15 是英文疑似项粗扫；本表还包含同一目标文件内原先硬编码的中文/混合 UI 文案，以保证语言切换真正生效。

| 文件 | 处数 | 抽取后的 key |
| --- | ---: | --- |
| `packages/gui/src/renderer/App.tsx` | 14 | `components.appSidebar.localModeNotSynchronizedV2MultiTerminal`<br>`components.appSidebar.local`<br>`components.appSidebar.activeWorkSummary`<br>`components.appSidebar.noTaskRowsFromLocalBridge`<br>`components.appSidebar.failedReadLedgerBridge`<br>`components.appSidebar.readLocalLedger`<br>`components.appSidebar.quicklySwitchProjects`<br>`components.appSidebar.quickSwitch`<br>`components.appSidebar.projectCount`<br>`components.appSidebar.manageAll`<br>`components.appSidebar.localMode`<br>`components.appSidebar.v2PreviewAfterLoggingYourAccountYou`<br>`components.appSidebar.localMode2`<br>`components.appSidebar.accountSynchronizationV2` |
| `packages/gui/src/renderer/components/DecisionJudgmentPanel.tsx` | 7 | `views.decisionsVerdict.rationaleValidation`<br>`views.decisionsVerdict.judgmentOnlyValidation`<br>`views.decisionsVerdict.actionRationaleLabel`<br>`views.decisionsVerdict.rationalePlaceholder`<br>`views.decisionsVerdict.judgmentOnlyRationaleLabel`<br>`views.decisionsVerdict.judgmentOnlyPlaceholder`<br>`views.decisionsVerdict.confirmAction` |
| `packages/gui/src/renderer/components/DecisionProposalForm.tsx` | 36 | `views.decisionPropose.columnsRequired`<br>`views.decisionPropose.packetRequired`<br>`views.decisionPropose.riskUrgencyRequired`<br>`views.decisionPropose.unknownRelation`<br>`views.decisionPropose.invalidLoadBearing`<br>`views.decisionPropose.invalidFulfillment`<br>`views.decisionPropose.packetTitle`<br>`views.decisionPropose.close`<br>`views.decisionPropose.titleLabel`<br>`views.decisionPropose.questionLabel`<br>`views.decisionPropose.riskPerson`<br>`views.decisionPropose.selectPlaceholder` ×2<br>`views.decisionPropose.riskLow`<br>`views.decisionPropose.riskMedium`<br>`views.decisionPropose.riskHigh`<br>`views.decisionPropose.urgencyPerson`<br>`views.decisionPropose.urgencyLow`<br>`views.decisionPropose.urgencyMedium`<br>`views.decisionPropose.urgencyHigh`<br>`views.decisionPropose.verticalLabel`<br>`views.decisionPropose.presetLabel`<br>`views.decisionPropose.decisionClassLabel`<br>`views.decisionPropose.ordinary`<br>`views.decisionPropose.standingPolicy`<br>`views.decisionPropose.appliesModules`<br>`views.decisionPropose.appliesProductLines`<br>`views.decisionPropose.chosenPacket`<br>`views.decisionPropose.rejectedPacket`<br>`views.decisionPropose.claimsPacket`<br>`views.decisionPropose.fulfillmentsPacket`<br>`views.decisionPropose.relationsPacket`<br>`views.decisionPropose.bodyBackground`<br>`views.decisionPropose.bodyTradeoffs`<br>`views.decisionPropose.bodyConclusion`<br>`views.decisionPropose.submitPacket` |
| `packages/gui/src/renderer/components/FactInspector.tsx` | 23 | `components.factInspector.title`<br>`components.factInspector.checkingSourceSupportingRelationshipsContradictionsSupersedeStatus`<br>`components.factInspector.focusFactDiagram`<br>`components.factInspector.closeFactInspector`<br>`components.factInspector.danglingFactReference`<br>`components.factInspector.inv6WillDetectAnchorNotPresent`<br>`components.factInspector.confidenceValue`<br>`components.factInspector.sourceValue`<br>`components.factInspector.unknown`<br>`components.factInspector.taskPackage`<br>`components.factInspector.jumpSourceTask`<br>`components.factInspector.hostTaskNotProjectedByCurrentTask`<br>`components.factInspector.moduleSourceValue`<br>`components.factInspector.provenance`<br>`components.factInspector.noProvenance`<br>`components.factInspector.incomingRelation`<br>`components.factInspector.noIncomingRelation`<br>`components.factInspector.supportingDecisionTitle`<br>`components.factInspector.jumpDecision`<br>`components.factInspector.unknownDecision`<br>`components.factInspector.dangerousLiaisons`<br>`components.factInspector.contradictsValue`<br>`components.factInspector.replacedByValue` |
| `packages/gui/src/renderer/components/RuntimeControlPanel.tsx` | 28 | `components.runtimeControlPanel.title`<br>`components.runtimeControlPanel.inventoryPinned`<br>`views.agentRuntimeView.spawnKind` ×2<br>`components.runtimeControlPanel.taskBinding`<br>`components.runtimeControlPanel.runtimeTask`<br>`components.runtimeControlPanel.noTask`<br>`views.agentRuntimeView.spawnCwd`<br>`components.runtimeControlPanel.runtimeCwdScope`<br>`components.runtimeControlPanel.repositoryRoot`<br>`components.runtimeControlPanel.repositoryRelative`<br>`components.runtimeControlPanel.relativePath`<br>`views.agentRuntimeView.spawnPrompt`<br>`components.runtimeControlPanel.runtimePrompt`<br>`views.agentRuntimeView.spawnPromptPlaceholder`<br>`views.agentRuntimeView.spawning`<br>`views.agentRuntimeView.spawn`<br>`components.runtimeControlPanel.frozenDefinition`<br>`components.runtimeControlPanel.frozenDefinitionDescription`<br>`components.runtimeControlPanel.kind`<br>`components.runtimeControlPanel.unknownNotProjected` ×5<br>`components.runtimeControlPanel.installation`<br>`components.runtimeControlPanel.auth`<br>`components.runtimeControlPanel.isolation` |
| `packages/gui/src/renderer/components/RuntimeInstanceManager.tsx` | 11 | `components.runtimeInstanceManager.operationWithSession`<br>`components.runtimeInstanceManager.operationApplied`<br>`components.runtimeInstanceManager.operationFailed`<br>`components.runtimeInstanceManager.readFailed`<br>`components.runtimeInstanceManager.loading`<br>`components.runtimeInstanceManager.readinessRefreshed`<br>`components.runtimeInstanceManager.instanceCreated`<br>`components.runtimeInstanceManager.safeInstanceDetail`<br>`components.runtimeInstanceManager.instanceDeleted`<br>`components.runtimeInstanceManager.authenticationChecked`<br>`components.runtimeInstanceManager.providerTerminalStarted` |
| `packages/gui/src/renderer/components/RuntimeInstanceManagerPanel.tsx` | 49 | `components.runtimeInstanceManagerPanel.runtimeInstances` ×2<br>`components.runtimeInstanceManagerPanel.machineLocalIsolated`<br>`components.runtimeInstanceManagerPanel.refreshReadiness`<br>`components.runtimeInstanceManagerPanel.instanceModel`<br>`components.runtimeInstanceManagerPanel.installation`<br>`components.runtimeInstanceManagerPanel.authentication` ×2<br>`components.runtimeInstanceManagerPanel.isolation` ×2<br>`components.runtimeInstanceManagerPanel.actions`<br>`components.runtimeInstanceManagerPanel.empty`<br>`components.runtimeInstanceManagerPanel.credentialVerified`<br>`components.runtimeInstanceManagerPanel.dedicatedStateRoot`<br>`components.runtimeInstanceManagerPanel.view`<br>`components.runtimeInstanceManagerPanel.validate`<br>`components.runtimeInstanceManagerPanel.signIn`<br>`components.runtimeInstanceManagerPanel.reauth`<br>`components.runtimeInstanceManagerPanel.signOut`<br>`components.runtimeInstanceManagerPanel.confirmDelete`<br>`components.runtimeInstanceManagerPanel.delete`<br>`components.runtimeInstanceManagerPanel.safeInstanceDetail` ×2<br>`components.runtimeInstanceManagerPanel.close`<br>`components.runtimeInstanceManagerPanel.instance`<br>`components.runtimeInstanceManagerPanel.kindProvider`<br>`components.runtimeInstanceManagerPanel.modelEffort`<br>`components.runtimeInstanceManagerPanel.default`<br>`components.runtimeInstanceManagerPanel.baseUrl`<br>`components.runtimeInstanceManagerPanel.providerDefault`<br>`components.runtimeInstanceManagerPanel.auth`<br>`components.runtimeInstanceManagerPanel.createInstance`<br>`components.runtimeInstanceManagerPanel.securePromptDescription`<br>`components.runtimeInstanceManagerPanel.instanceId`<br>`components.runtimeInstanceManagerPanel.instanceIdPlaceholder`<br>`components.runtimeInstanceManagerPanel.name`<br>`components.runtimeInstanceManagerPanel.namePlaceholder`<br>`components.runtimeInstanceManagerPanel.runtime`<br>`components.runtimeInstanceManagerPanel.witnessedInstallation`<br>`components.runtimeInstanceManagerPanel.noWitnessedInstallation`<br>`components.runtimeInstanceManagerPanel.provider`<br>`components.runtimeInstanceManagerPanel.model`<br>`components.runtimeInstanceManagerPanel.modelPlaceholder`<br>`components.runtimeInstanceManagerPanel.reasoningEffort`<br>`components.runtimeInstanceManagerPanel.optional`<br>`components.runtimeInstanceManagerPanel.apiBaseUrl`<br>`components.runtimeInstanceManagerPanel.optionalHttps`<br>`components.runtimeInstanceManagerPanel.createSecurePrompt`<br>`components.runtimeInstanceManagerPanel.createSubscription` |
| `packages/gui/src/renderer/components/TaskControlPanel.tsx` | 21 | `components.taskControlPanel.readOnlyExternal`<br>`components.taskControlPanel.readOnlyArchived`<br>`components.taskControlPanel.readOnlyInReview`<br>`components.taskControlPanel.readOnlyDone`<br>`components.taskControlPanel.plannedBlocked`<br>`components.taskControlPanel.planned`<br>`components.taskControlPanel.activeWithoutLease`<br>`components.taskControlPanel.title`<br>`components.taskControlPanel.blockerCount`<br>`components.taskControlPanel.warning`<br>`components.taskControlPanel.lease`<br>`components.taskControlPanel.addProgress`<br>`components.taskControlPanel.evidenceFormat`<br>`components.taskControlPanel.progressOriginal`<br>`components.taskControlPanel.evidencePlaceholder`<br>`components.taskControlPanel.writeProgress`<br>`components.taskControlPanel.requestReview`<br>`components.taskControlPanel.completionClaim`<br>`components.taskControlPanel.eachLineOneItem`<br>`components.taskControlPanel.commitSha`<br>`components.taskControlPanel.submitReview` |
| `packages/gui/src/renderer/components/TaskFilterBar.tsx` | 16 | `components.taskFilterBar.all` ×2<br>`components.taskFilterBar.countItems`<br>`components.taskFilterBar.status`<br>`components.taskFilterBar.clearStatusFilter`<br>`components.taskFilterBar.searchTasksModulesStatusWithinContextLabel`<br>`components.taskFilterBar.module`<br>`components.taskFilterBar.engine`<br>`components.taskFilterBar.closeout`<br>`components.taskFilterBar.freshness`<br>`components.taskFilterBar.archive`<br>`components.taskFilterBar.viewOnlyFavoriteTasksFavoriteCountTotal`<br>`components.taskFilterBar.viewOnlyCollection`<br>`components.taskFilterBar.clear`<br>`components.taskFilterBar.filteredTaskCount`<br>`components.taskFilterBar.archivedCancelledHiddenByDefaultReduceNoise` |
| `packages/gui/src/renderer/components/TaskPreviewDrawer.tsx` | 25 | `components.taskPreviewDrawer.readOnlySource`<br>`components.taskPreviewDrawer.closeTaskPreview`<br>`components.taskPreviewDrawer.canonical`<br>`components.taskPreviewDrawer.blockingUnknown`<br>`components.taskPreviewDrawer.context`<br>`components.taskPreviewDrawer.module`<br>`components.taskPreviewDrawer.notProjected` ×2<br>`components.taskPreviewDrawer.rawStatus`<br>`components.taskPreviewDrawer.package`<br>`components.taskPreviewDrawer.source`<br>`components.taskPreviewDrawer.productLines`<br>`components.taskPreviewDrawer.parentRoot`<br>`components.taskPreviewDrawer.gates`<br>`components.taskPreviewDrawer.thereNoGateRecordYet`<br>`components.taskPreviewDrawer.closingMaterial`<br>`components.taskPreviewDrawer.documentListUnavailable`<br>`components.taskPreviewDrawer.requiredDocumentationComplete`<br>`components.taskPreviewDrawer.missingDocument`<br>`components.taskPreviewDrawer.associatedTasks`<br>`components.taskPreviewDrawer.thereCurrentlyNoRelatedEdges`<br>`components.taskPreviewDrawer.recentEvents`<br>`components.taskPreviewDrawer.noEventsYet`<br>`components.taskPreviewDrawer.openFullDetails`<br>`components.taskPreviewDrawer.close` |
| `packages/gui/src/renderer/components/TerminalDock.tsx` | 32 | `terminal.dock.title` ×4<br>`terminal.dock.replayGap`<br>`terminal.dock.spawnRejected`<br>`terminal.dock.terminationConfirmed`<br>`terminal.dock.shortcut` ×3<br>`terminal.dock.resizeHandleAria`<br>`terminal.dock.resizeHandleTitle`<br>`terminal.dock.localDirectPty`<br>`terminal.dock.repoGeneration`<br>`views.settingsView.systemUnknownDash`<br>`terminal.dock.close`<br>`terminal.dock.name`<br>`terminal.dock.cwd`<br>`terminal.dock.path`<br>`terminal.dock.shell`<br>`terminal.dock.task`<br>`terminal.dock.unbound`<br>`terminal.dock.newTab`<br>`terminal.dock.attachExisting`<br>`terminal.dock.attachSession`<br>`terminal.dock.empty`<br>`terminal.dock.closeDetachTitle`<br>`terminal.dock.closeDetach`<br>`terminal.dock.confirmTerminate`<br>`terminal.dock.terminate`<br>`terminal.dock.sessionNotInteractive`<br>`terminal.dock.startHint` |
| `packages/gui/src/renderer/components/badges.tsx` | 9 | `components.badges.lastKnown`<br>`components.badges.agnosticNoCaching`<br>`components.badges.riskSignificanceDepthReview`<br>`components.badges.urgentQueueQueue`<br>`components.badges.derivedFromDecisionIdTitle`<br>`components.badges.derivedFromDecisionId`<br>`components.badges.tooltipClickJump`<br>`components.badges.derivedFrom2`<br>`components.badges.derivedFrom` |
| `packages/gui/src/renderer/graph/GraphDrawer.tsx` | 27 | `graph.graphDrawer.edgeRelation`<br>`graph.graphDrawer.exitFocusEsc` ×2<br>`graph.graphDrawer.edgeKindMessage`<br>`graph.graphDrawer.from`<br>`graph.graphDrawer.to`<br>`graph.graphDrawer.provenance`<br>`graph.graphDrawer.jumpSourceNode`<br>`graph.graphDrawer.jumpTargetNode`<br>`graph.graphDrawer.openSidebarTaskDetailsDecisionDecisionPool`<br>`graph.graphDrawer.open`<br>`graph.graphDrawer.moduleValue`<br>`graph.graphDrawer.rawValue`<br>`graph.graphDrawer.riskUrgency`<br>`graph.graphDrawer.unknown` ×2<br>`graph.graphDrawer.question`<br>`graph.graphDrawer.chosen`<br>`graph.graphDrawer.claims`<br>`graph.graphDrawer.factObservation`<br>`graph.graphDrawer.anchorDetails`<br>`graph.graphDrawer.taskIdValue`<br>`graph.graphDrawer.anchorValue`<br>`graph.graphDrawer.node`<br>`graph.graphDrawer.chainCounts`<br>`graph.graphDrawer.outEdgesCount`<br>`graph.graphDrawer.inEdgesCount` |
| `packages/gui/src/renderer/views/AdaptersView.tsx` | 11 | `views.adaptersView.readingAdapterRegistry`<br>`views.adaptersView.adapterRegistryReadFailed`<br>`views.adaptersView.unknownNotProjected` ×2<br>`views.adaptersView.registryTitle`<br>`views.adaptersView.readOnlyDescription`<br>`views.adaptersView.default`<br>`views.adaptersView.projectedTasks`<br>`views.adaptersView.capabilities`<br>`views.adaptersView.registeredAvailable`<br>`views.adaptersView.registryEmpty` |
| `packages/gui/src/renderer/views/DecisionPoolView.tsx` | 42 | `views.decisionPoolView.coverageValue`<br>`views.decisionPoolView.noSupersedeAmendChain`<br>`views.decisionPoolView.retiresValue`<br>`views.decisionPoolView.supersededByValue`<br>`views.decisionPoolView.amendedAtValue`<br>`renderer.shellConfig.decisionPool`<br>`views.decisionPoolView.subtitle`<br>`views.decisionPoolView.proposal`<br>`views.decisionPoolView.visibleCount`<br>`views.decisionPoolView.decisionSearch`<br>`views.decisionPoolView.searchTitleIdQuestion`<br>`views.decisionPoolView.filterModule` ×2<br>`views.decisionPoolView.filterAll` ×2<br>`views.decisionPoolView.filterProductLine` ×2<br>`views.decisionPoolView.stateAll`<br>`views.decisionPoolView.filterRisk`<br>`views.decisionPoolView.riskAll`<br>`views.decisionPoolView.filterUrgency`<br>`views.decisionPoolView.urgencyAll`<br>`views.decisionPoolView.filterVertical`<br>`views.decisionPoolView.verticalAll`<br>`views.decisionPoolView.filterPreset`<br>`views.decisionPoolView.presetAll`<br>`views.decisionPoolView.filterProposedBy`<br>`views.decisionPoolView.filterProposedByAll`<br>`views.decisionPoolView.timeAll`<br>`views.decisionPoolView.timeLast14Days`<br>`views.decisionPoolView.timeLast30Days`<br>`views.decisionPoolView.filterGroupBy`<br>`views.decisionPoolView.groupByTitle`<br>`views.decisionPoolView.groupByNone`<br>`views.decisionPoolView.groupByMilestone`<br>`views.decisionPoolView.groupByVertical`<br>`views.decisionPoolView.projectionUnknown`<br>`views.decisionPoolView.allGroup`<br>`views.decisionPoolView.groupCount`<br>`views.decisionPoolView.focusDecisionDiagram`<br>`views.decisionPoolView.canonicalBodyConsents`<br>`views.decisionPoolView.emptyFilter` |
| `packages/gui/src/renderer/views/DecisionsView.tsx` | 3 | `views.decisionsView.canonicalJudgmentHistory`<br>`views.decisionsView.pathUnknown`<br>`views.decisionsView.notInCurrentSession` |
| `packages/gui/src/renderer/views/ExecutionEvidenceView.tsx` | 50 | `views.executionEvidenceView.evidenceExecution`<br>`views.executionEvidenceView.verifiedSnapshot`<br>`views.executionEvidenceView.originCheckerWitness`<br>`views.executionEvidenceView.snapshotCatchingUp`<br>`views.executionEvidenceView.loadingExecutionProjection`<br>`views.executionEvidenceView.emptySnapshotFilter`<br>`views.executionEvidenceView.statsExecutions`<br>`views.executionEvidenceView.statsTasksWithExecutions`<br>`views.executionEvidenceView.statsOutputs`<br>`views.executionEvidenceView.statsArchival`<br>`views.executionEvidenceView.statsNative`<br>`views.executionEvidenceView.statsPassingReceipt`<br>`views.executionEvidenceView.statsUnknownOrigin`<br>`views.executionEvidenceView.receiptFilter`<br>`views.executionEvidenceView.all` ×2<br>`views.executionEvidenceView.thereReceipt`<br>`views.executionEvidenceView.noReceipt`<br>`views.executionEvidenceView.originFilter`<br>`views.executionEvidenceView.archive` ×2<br>`views.executionEvidenceView.native` ×2<br>`views.executionEvidenceView.reload`<br>`views.executionEvidenceView.visibleExecutions`<br>`views.executionEvidenceView.groupCounts`<br>`views.executionEvidenceView.iterationCommit`<br>`views.executionEvidenceView.outputCounts`<br>`views.executionEvidenceView.outputSummary`<br>`views.executionEvidenceView.executionWitnessCounts`<br>`views.executionEvidenceView.notOutputReceipt`<br>`views.executionEvidenceView.noExecutionOutput`<br>`views.executionEvidenceView.moreOutputs`<br>`views.executionEvidenceView.evidenceId`<br>`views.executionEvidenceView.substrate`<br>`views.executionEvidenceView.locator`<br>`views.executionEvidenceView.checkerReceiptRef`<br>`views.executionEvidenceView.checkerResult`<br>`views.executionEvidenceView.witnessTitle`<br>`views.executionEvidenceView.reviewsSnapshotValidated`<br>`views.executionEvidenceView.noneCurrentCut`<br>`views.executionEvidenceView.paginationLabel`<br>`views.executionEvidenceView.previousPage`<br>`views.executionEvidenceView.pageOf`<br>`views.executionEvidenceView.nextPage`<br>`views.executionEvidenceView.reloadCurrentQuery`<br>`views.executionEvidenceView.reloadFromFirstPage` ×2<br>`views.executionEvidenceView.readFailed`<br>`views.executionEvidenceView.retryCurrentQuery` |
| `packages/gui/src/renderer/views/ListView.tsx` | 35 | `views.listView.cancelFavorites`<br>`views.listView.favoritesPinned`<br>`views.listView.notProjected`<br>`views.listView.blockingUnknown`<br>`views.listView.list` ×2<br>`views.listView.auditFormsLocateTasksExternalReadOnly`<br>`views.listView.filteredCount`<br>`views.listView.batchOperations`<br>`views.listView.itemsSelected`<br>`views.listView.simulatedBatchCheck`<br>`views.listView.runCheckBatches`<br>`views.listView.simulatedBatchReady`<br>`views.listView.batchMarkReady`<br>`views.listView.simulatedBatchArchive`<br>`views.listView.batchArchiving`<br>`views.listView.deselect`<br>`views.listView.currentResults`<br>`views.listView.externalReadOnly`<br>`views.listView.riskLossContact`<br>`views.listView.noMatchingTasks`<br>`views.listView.broadenSearchModuleStatusOpenArchivesView`<br>`views.listView.collection`<br>`views.listView.task`<br>`views.listView.titleModule`<br>`views.listView.status`<br>`views.listView.closeout`<br>`views.listView.engine`<br>`views.listView.freshness`<br>`views.listView.package`<br>`views.listView.pageCount`<br>`views.listView.rowCount`<br>`views.listView.perPage`<br>`views.listView.previousPage`<br>`views.listView.nextPage` |
| `packages/gui/src/renderer/views/PresetsView.tsx` | 41 | `views.presetsView.readingCatalogSnapshot`<br>`views.presetsView.catalogReadFailed`<br>`views.presetsView.unknownNotProjected` ×8<br>`views.presetsView.catalogPreset`<br>`views.presetsView.reread`<br>`views.presetsView.activationDescription`<br>`views.presetsView.projectRuntimeInstance`<br>`views.presetsView.notSelected` ×3<br>`views.presetsView.operationId`<br>`views.presetsView.default`<br>`views.presetsView.vertical` ×2<br>`views.presetsView.version`<br>`views.presetsView.entrypoints`<br>`views.presetsView.shadowBundled`<br>`views.presetsView.valid`<br>`views.presetsView.invalid`<br>`views.presetsView.available`<br>`views.presetsView.unavailable`<br>`views.presetsView.source`<br>`views.presetsView.locale` ×2<br>`views.presetsView.snapshotDefault`<br>`views.presetsView.resolvedPreset`<br>`views.presetsView.resolving`<br>`views.presetsView.none` ×3<br>`views.presetsView.runtimeInstanceRef`<br>`views.presetsView.capabilityImports`<br>`views.presetsView.copied`<br>`views.presetsView.provenanceAncestry` |
| `packages/gui/src/renderer/views/RuntimeWorkspace.tsx` | 2 | `views.agentRuntimeView.runtimeReadFailed`<br>`views.agentRuntimeView.loadingRuntimeProjection` |
| `packages/gui/src/renderer/views/SettingsView.tsx` | 1 | `views.settingsView.english` |
| `packages/gui/src/renderer/views/SystemView.tsx` | 28 | `views.settingsView.systemLoading`<br>`views.systemView.readFailed`<br>`views.settingsView.systemUnknownDash` ×9<br>`shell.nav.system`<br>`views.settingsView.systemRefresh`<br>`views.settingsView.systemRestart`<br>`views.systemView.endpoint`<br>`views.systemView.protocol`<br>`views.systemView.build`<br>`views.systemView.operationId`<br>`views.systemView.daemonGeneration`<br>`views.systemView.started`<br>`views.systemView.uptime`<br>`views.systemView.activeControl`<br>`views.systemView.observed`<br>`views.systemView.repoCellRoster`<br>`views.systemView.generation`<br>`views.systemView.queue`<br>`views.systemView.lock`<br>`views.systemView.recovery` |
| `packages/gui/src/renderer/views/TaskDetailView.tsx` | 26 | `views.taskDetailView.thereNoProjectionDocumentTask`<br>`views.taskDetailView.listDocMaterializedFromPresetEmpty`<br>`views.taskDetailView.reading` ×2<br>`views.taskDetailView.documentReadingFailed` ×2<br>`views.taskDetailView.documentNotMaterialized`<br>`views.taskDetailView.workspace`<br>`views.taskDetailView.returnPreviousLevel`<br>`views.taskDetailView.localLedgerBridgeDidNotReturn`<br>`components.docTree.required`<br>`components.docTree.missing`<br>`views.taskDetailView.noDocumentation`<br>`views.taskDetailView.coordinationStatus`<br>`views.taskDetailView.closeoutReadiness`<br>`views.taskDetailView.packageDisposition`<br>`views.taskDetailView.placement`<br>`views.taskDetailView.stage`<br>`views.taskDetailView.decisionUpstream`<br>`views.taskDetailView.gates`<br>`views.taskDetailView.noGateRecord`<br>`views.taskDetailView.relationship`<br>`views.taskDetailView.readOnlyCanonicalRelation`<br>`views.taskDetailView.unrelatedTasks`<br>`views.taskDetailView.outSide`<br>`views.taskDetailView.enterEdge` |
| `packages/gui/src/renderer/views/agent-runtime-view.tsx` | 25 | `views.agentRuntimeView.runtimeReadFailed`<br>`views.agentRuntimeView.loadingRuntimeProjection`<br>`views.agentRuntimeView.sessionsTitle`<br>`views.agentRuntimeView.witnessedNativeRuntimes`<br>`views.agentRuntimeView.instanceModel`<br>`views.agentRuntimeView.session`<br>`views.agentRuntimeView.holderLease`<br>`views.agentRuntimeView.activity`<br>`views.agentRuntimeView.noWitnessedSessions`<br>`views.agentRuntimeView.unheld`<br>`views.agentRuntimeView.noLease`<br>`views.agentRuntimeView.sessionDetail`<br>`views.agentRuntimeView.closePane`<br>`views.agentRuntimeView.fieldSession`<br>`views.agentRuntimeView.fieldInstance`<br>`views.agentRuntimeView.fieldInstallation`<br>`views.agentRuntimeView.fieldProvider`<br>`views.agentRuntimeView.fieldModel`<br>`views.agentRuntimeView.fieldAuthMode`<br>`views.agentRuntimeView.fieldProviderSession`<br>`views.agentRuntimeView.notBound`<br>`views.agentRuntimeView.fieldLiveness`<br>`views.agentRuntimeView.fieldAttach`<br>`views.agentRuntimeView.fieldLastActivity`<br>`views.agentRuntimeView.readOnlyActivity` |
| `packages/gui/src/renderer/views/decisions-verdict.tsx` | 4 | `views.decisionsVerdict.danglingReferenceNonExistentFactAnchor`<br>`views.decisionsVerdict.chosen`<br>`views.decisionsVerdict.rejected`<br>`views.decisionsVerdict.provenance` |

## 类型 B：zh-CN 原值仍为英文的 28 条

| 文件/key | 原值 | 当前译法 | 处置/理由 |
| --- | --- | --- | --- |
| `graph.json::graph.territoryPartition.milestoneLandingTitle` | `PLT · {landingTitle}` | 保留原文 | `PLT` 与动态 `landingTitle` 是产品/数据标识，按规则保留 |
| `rebuild.json::shell.nav.presets` | `Preset / Vertical` | `预设 / 垂直领域` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `rebuild.json::shell.nav.agents` | `Agent Sessions` | `Agent 会话` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `rebuild.json::shell.nav.system` | `System` | `系统` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `renderer.json::renderer.shellConfig.agentRuntime` | `Agent Runtime` | `Agent 运行时` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `terminal.json::terminal.dock.shortcut` | Ctrl+\` | 保留原文 | 快捷键按规则保留 |
| `views.json::views.agentRuntimeView.title` | `Agent Runtime` | `Agent 运行时` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `views.json::views.agentRuntimeView.sessionsTitle` | `Sessions` | `会话` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `views.json::views.agentRuntimeView.stateAlive` | `alive` | 保留原文 | 状态机字面值/状态码按规则保留 |
| `views.json::views.agentRuntimeView.stateCompleted` | `completed` | 保留原文 | 状态机字面值/状态码按规则保留 |
| `views.json::views.agentRuntimeView.stateFailed` | `failed` | 保留原文 | 状态机字面值/状态码按规则保留 |
| `views.json::views.agentRuntimeView.stateUnknown` | `unknown` | 保留原文 | 状态机字面值/状态码按规则保留 |
| `views.json::views.agentRuntimeView.taskBound` | `task {id}` | 保留原文 | 技术术语、字段名或动态数据模板，按规则保留 |
| `views.json::views.agentRuntimeView.detailSessionId` | `sessionId` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.agentRuntimeView.detailKind` | `kind` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.agentRuntimeView.detailProviderSession` | `provider session` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.agentRuntimeView.detailPid` | `pid` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.agentRuntimeView.detailTaskId` | `taskId` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.agentRuntimeView.detailExecutionId` | `executionId` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.agentRuntimeView.spawnKind` | `Runtime instance` | `Runtime 实例` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `views.json::views.agentRuntimeView.spawnPrompt` | `Prompt` | 保留原文 | 技术术语、字段名或动态数据模板，按规则保留 |
| `views.json::views.decisionPropose.errorCodeValue` | `code: {code}` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.decisionPropose.errorHintValue` | `hint: {hint}` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.settingsView.english` | `English` | `英文` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |
| `views.json::views.settingsView.systemPid` | `PID` | 保留原文 | 字段名、错误字段或筛选字段，按规则保留 |
| `views.json::views.settingsView.systemUnknownDash` | `—` | 保留原文 | 空值 sentinel 按规则保留 |
| `views.json::views.settingsView.systemUnlockedDash` | `—` | 保留原文 | 空值 sentinel 按规则保留 |
| `views.json::views.taskDetailView.executionReview` | `Execution Review` | `执行审查` | 完整 UI 文案已中文化；核心概念/技术词按建议保留 |

## 产品核心概念词建议（请 CEO 逐条复核）

| 原文 | 建议译法 | 理由 |
| --- | --- | --- |
| Preset | 预设 | 中文 UI 中作为产品对象名使用，语义直接且稳定。 |
| Vertical | 垂直领域 | 保留产品抽象的“领域”含义，不把它误译成版式/方向。 |
| Agent Runtime | Agent 运行时 | `Agent` 是领域术语；`Runtime` 翻成运行时，符合技术语境。 |
| Adapter | 适配器 | 使用标准中文技术词，避免导航中出现半英文化的 `Adapter`。已写入 `shell.nav.adapters` / `renderer.shellConfig.engineAdapter`。 |
| Agent Sessions | Agent 会话 | 保留 `Agent` 领域词，`Sessions` 翻成会话。 |
| System | 系统 | 普通页面/导航标题，无需保留英文。 |

## zh-CN 自检：当前仍不含中文字符的值

统计规则：对最终 `zh-CN` locale 的字符串执行 `/[一-龥]/u` 检查，共 **96 条**。以下均按产品规则保留：状态码、字段名/路径/schema 形状、协议/领域术语、动态数据模板、快捷键、品牌/model/provider 示例或空值 sentinel。

| 文件/key | 值 | 保留理由 |
| --- | --- | --- |
| `components.json::components.taskPreviewDrawer.canonical` | `canonical` | 技术/领域术语或动态字段模板，按规则保留 |
| `components.json::components.taskPreviewDrawer.productLines` | `product lines` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.taskPreviewDrawer.parentRoot` | `parent / root` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.taskControlPanel.lease` | `lease · {executionId}` | 技术/领域术语或动态字段模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.runtimeInstances` | `Runtime instances` | 技术/领域术语或动态字段模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.machineLocalIsolated` | `machine local · isolated` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.installation` | `installation` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.baseUrl` | `Base URL` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.auth` | `Auth` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.instanceId` | `Instance id` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.instanceIdPlaceholder` | `codex-review` | 用户输入示例、实例名或 model/provider 标识 |
| `components.json::components.runtimeInstanceManagerPanel.namePlaceholder` | `Codex Review` | 用户输入示例、实例名或 model/provider 标识 |
| `components.json::components.runtimeInstanceManagerPanel.runtime` | `Runtime` | 技术/领域术语或动态字段模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.provider` | `Provider` | 技术/领域术语或动态字段模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.model` | `Model` | 技术/领域术语或动态字段模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.modelPlaceholder` | `gpt-5.6-sol` | 技术标识或动态数据模板，按规则保留 |
| `components.json::components.runtimeInstanceManagerPanel.apiBaseUrl` | `API base URL` | 技术标识或动态数据模板，按规则保留 |
| `graph.json::graph.territoryPartition.milestoneLandingTitle` | `PLT · {landingTitle}` | PLT 与动态数据模板 |
| `terminal.json::terminal.dock.shortcut` | `Ctrl+`` | 快捷键，按规则保留 |
| `terminal.json::terminal.dock.repoGeneration` | `repo {repoId} · generation {generation}` | 技术/领域术语或动态字段模板，按规则保留 |
| `terminal.json::terminal.dock.cwd` | `cwd` | 技术标识或动态数据模板，按规则保留 |
| `terminal.json::terminal.dock.shell` | `shell` | 技术/领域术语或动态字段模板，按规则保留 |
| `terminal.json::terminal.dock.task` | `task` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.agentRuntimeView.stateAlive` | `alive` | 状态机字面值/状态码，按规则保留 |
| `views.json::views.agentRuntimeView.stateCompleted` | `completed` | 状态机字面值/状态码，按规则保留 |
| `views.json::views.agentRuntimeView.stateFailed` | `failed` | 状态机字面值/状态码，按规则保留 |
| `views.json::views.agentRuntimeView.stateUnknown` | `unknown` | 状态机字面值/状态码，按规则保留 |
| `views.json::views.agentRuntimeView.taskBound` | `task {id}` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.agentRuntimeView.detailSessionId` | `sessionId` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.detailKind` | `kind` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.detailProviderSession` | `provider session` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.detailPid` | `pid` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.detailTaskId` | `taskId` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.detailExecutionId` | `executionId` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.spawnPrompt` | `Prompt` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.decisionPropose.errorCodeValue` | `code: {code}` | 技术标识或动态数据模板，按规则保留 |
| `views.json::views.decisionPropose.errorHintValue` | `hint: {hint}` | 技术标识或动态数据模板，按规则保留 |
| `views.json::views.decisionPropose.questionLabel` | `question` | 技术标识或动态数据模板，按规则保留 |
| `views.json::views.decisionPropose.titleLabel` | `title` | 技术标识或动态数据模板，按规则保留 |
| `views.json::views.settingsView.systemPid` | `PID` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.settingsView.systemUnknownDash` | `—` | 空值 sentinel，按规则保留 |
| `views.json::views.settingsView.systemUnlockedDash` | `—` | 空值 sentinel，按规则保留 |
| `views.json::views.decisionPoolView.filterModule` | `module` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.decisionPoolView.filterProductLine` | `productLine` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.decisionPoolView.filterProposedBy` | `proposedBy` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldSession` | `Session` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldInstance` | `Instance` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldInstallation` | `Installation` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldProvider` | `Provider` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldModel` | `Model` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldAuthMode` | `Auth mode` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldProviderSession` | `provider session` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldLiveness` | `Liveness` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldAttach` | `attach` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.agentRuntimeView.fieldLastActivity` | `Last activity` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.executionEvidenceView.statsArchival` | `origin=archival` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.executionEvidenceView.statsNative` | `origin=native` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.executionEvidenceView.statsUnknownOrigin` | `unknown origin` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.executionEvidenceView.receiptFilter` | `receipt` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.executionEvidenceView.reload` | `reload…` | 技术标识或动态数据模板，按规则保留 |
| `views.json::views.executionEvidenceView.originFilter` | `origin` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.executionEvidenceView.iterationCommit` | `iteration {iteration} · commit {commit}` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.executionEvidenceView.executionWitnessCounts` | `execution-level witnesses：review {reviews} · consent {consents} · gate {gates}` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.executionEvidenceView.evidenceId` | `evidenceId` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.executionEvidenceView.substrate` | `substrate` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.executionEvidenceView.locator` | `locator` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.executionEvidenceView.checkerReceiptRef` | `checker receipt ref` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.executionEvidenceView.checkerResult` | `checker result` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.executionEvidenceView.reviewsSnapshotValidated` | `reviews · snapshot-validated` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.systemView.endpoint` | `endpoint` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.protocol` | `protocol` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.build` | `build` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.operationId` | `operationId` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.generation` | `generation` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.queue` | `queue` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.lock` | `lock` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.recovery` | `recovery` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.systemView.pid` | `pid` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.presetsView.provenanceAncestry` | `provenance.ancestry` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.decisionPropose.verticalLabel` | `vertical` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.decisionPropose.presetLabel` | `preset` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.decisionPropose.decisionClassLabel` | `decisionClass` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.decisionPropose.ordinary` | `ordinary` | 技术标识或动态数据模板，按规则保留 |
| `views.json::views.decisionPropose.standingPolicy` | `standing_policy` | 技术标识或动态数据模板，按规则保留 |
| `views.json::views.decisionPropose.appliesModules` | `appliesTo.modules · CSV` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.decisionPropose.appliesProductLines` | `appliesTo.productLines · CSV` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.decisionPropose.chosenPacket` | `chosen · id \| text \| rationale?` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.decisionPropose.rejectedPacket` | `rejected · id \| text \| whyNot` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.decisionPropose.claimsPacket` | `claims · id \| text \| loadBearing` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.decisionPropose.fulfillmentsPacket` | `fulfillments · claimId \| mode` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.decisionPropose.relationsPacket` | `relations · anchor \| type \| target \| rationale` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.presetsView.operationId` | `operationId` | 字段名、路径、协议/操作标识或 schema 形状，按规则保留 |
| `views.json::views.presetsView.vertical` | `vertical` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.presetsView.locale` | `locale` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.presetsView.runtimeInstanceRef` | `runtime instance ref` | 技术/领域术语或动态字段模板，按规则保留 |
| `views.json::views.presetsView.capabilityImports` | `capability imports` | 技术/领域术语或动态字段模板，按规则保留 |

## 校验结果

| 项目 | 结果 |
| --- | --- |
| locale key parity | PASS：en-US 1603、zh-CN 1603；缺失 0/0 |
| direct locale key audit | PASS：当前改动 renderer 的固定 `t()` key 缺失 0 |
| `npm run check:local` | PASS：fast tier 31 steps；typecheck、test:fast 126/126、test:contract 397/397、lint 与本地 gates 全绿 |
| `npm run test:gui` | PASS：23/23 test files、179/179 tests |
| `node tools/gates/test-selection.mjs --base origin/rebuild/main` | PASS：required/path/proof/errors 均为空 |
| `node --test tools/gates/test/module-policy.test.mjs` | PASS：26/26；GUI i18n production-paths fixture 已真实接线 |
| renderer 颜色 token 门 / 重复定义门 | PASS：包含在本轮 local gates，未误伤 |

## line-budget

| bucket | 基线 ceiling | 当前 ceiling | 实测占用 |
| --- | ---: | ---: | ---: |
| gui | 18150 | 18168 | 18168 |
| agent-runtime | 359 | 360 | 360 |

GUI ceiling 只抬高到当前实测值 `18168`，agent-runtime 只抬高到当前实测值 `360`；同一改动加入 `tools/gates/test/fixtures/gui-i18n-production-paths.json` 并接入 `tools/gates/test/module-policy.test.mjs`。line-budget 命令结果：PASS。

## commit

Implementation commit：`ba0b98f758248efb561f29453c9d6bd8fc091d9b`。
Report commit：本地 follow-up commit；最终 SHA 在交付消息列出。不 push、不创建 PR。

Finding: PASS
