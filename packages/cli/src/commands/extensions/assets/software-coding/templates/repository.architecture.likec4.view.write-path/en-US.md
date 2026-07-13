views {
  dynamic view writePath {
    title 'Coding Write Path'
    codingAgent -> repository 'reads architecture intent and proposes a change'
    repository -> runtimeEnvironment 'produces runtime behavior'
  }
}
