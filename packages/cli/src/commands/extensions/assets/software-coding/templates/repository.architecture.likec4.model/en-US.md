model {
  codingAgent = person 'Coding Agent' {
    description 'Replace this draft boundary with the repository coding actors.'
    metadata {
      archId 'actor.coding-agent'
      status 'draft'
      placeholder true
      owner 'replace-me'
      responsibilities ['understand architecture intent', 'propose scoped code changes']
      nonResponsibilities ['own repository policy', 'silently rewrite architecture intent']
    }
  }

  repository = softwareSystem 'Current Repository' {
    description 'Replace this draft node with component-level repository boundaries.'
    metadata {
      archId 'system.repository'
      status 'draft'
      placeholder true
      owner 'replace-me'
      responsibilities ['host authored code and architecture intent']
      nonResponsibilities ['represent generated dependency observations as intent']
      adrRefs ['harness/adr/ADR-0000-replace-me.md']
      decisionRefs ['decision/dec_replace_me']
    }
  }

  runtimeEnvironment = softwareSystem 'Runtime Environment' {
    description 'Replace this draft node with real runtime and external boundaries.'
    metadata {
      archId 'system.runtime-environment'
      status 'draft'
      placeholder true
      owner 'replace-me'
      responsibilities ['execute repository behavior']
      nonResponsibilities ['define authored repository architecture']
    }
  }

  codingAgent -> repository 'reads intent and proposes changes' {
    metadata {
      archId 'relation.agent-writes-repository'
      expectation 'allowed'
      status 'draft'
      placeholder true
      adrRefs ['harness/adr/ADR-0000-replace-me.md']
      decisionRefs ['decision/dec_replace_me']
    }
  }

  repository -> runtimeEnvironment 'produces runtime behavior' {
    metadata {
      archId 'relation.repository-runs-in-environment'
      expectation 'allowed'
      status 'draft'
      placeholder true
    }
  }
}
