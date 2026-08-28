cask "harness-anything" do
  version "0.0.1"
  sha256 "c462a7e443ba3d46c226f056bf5fafa7b48f181d8ce5f8bb8dc6c0926b37c350"

  url "https://github.com/FairladyZ625/harness-anything/releases/download/gui-v#{version}/Harness-Anything-#{version}-arm64.dmg"
  name "Harness Anything"
  desc "Local accountability layer for AI agents"
  homepage "https://github.com/FairladyZ625/harness-anything"

  depends_on arch: :arm64
  depends_on macos: ">= :monterey"

  app "Harness Anything.app"

  caveats <<~EOS
    Version #{version} is unsigned and unnotarized. On first launch, Control-click
    Harness Anything in Applications, choose Open, then confirm Open.
  EOS
end
