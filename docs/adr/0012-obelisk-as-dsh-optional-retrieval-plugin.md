# DeepSeek Harness exposes Obelisk through the canonical bundled skill

**Context.** DeepSeek Harness (DSH) has native session-history capabilities,
while Obelisk provides a machine-local archive spanning supported agent
harnesses together with human-approved durable memory. The integration needs to
add that cross-harness retrieval channel without replacing DSH's native history
features or defining a DSH-specific Obelisk contract. Obelisk's canonical skill
already defines when retrieval is appropriate, how to construct bounded
queries, how to preserve stable evidence identifiers, and how memory mutations
remain subject to human approval. DSH provides a standard skill registry,
catalog, skill-loading tool, Bash execution, permission policy, and precedence
for project-local skills.

**Decision.** Publish an opt-in DSH plugin named
`@obelisk/dsh-obelisk-plugin`. Its only DSH service dependency is `skills`,
through which it registers one model- and user-invocable bundled skill named
`obelisk`. The skill's name, description, instructions, and referenced
resources all come from the canonical `skill-doc/` tree. The build copies that
complete tree to `dist/skill`, and the runtime exposes the copied directory as
the skill's resource base. Development loads the same canonical tree directly
from the repository. A separately installed global skill is therefore not a
prerequisite, while DSH's existing precedence still allows a project-local
`obelisk` skill to override the bundled copy.

DSH presents the skill in its existing catalog and loads it through its
existing `skill` tool. After loading the instructions, the model uses DSH's
standard Bash tool to execute `obelisk --query "$qfile"`. The Obelisk CLI owns
query refresh and the retrieval data contract; DSH's Bash tool owns command
recording, permission handling, and presentation of stdout, stderr, and exit
status. This is the same model-facing invocation contract used by other agent
harnesses. The plugin's runtime prerequisite is the `obelisk` CLI on the DSH
process's `PATH`.

The integration preserves DSH's native session history as an independent
retrieval channel. Deployment enables the plugin through the normal Cordis
plugin row. Since this integration introduces no plugin-owned state or policy,
it has no settings namespace. Obelisk calls use DSH's standard Bash
presentation. A future dedicated presentation may be added through a
plugin-owned attribution or decoration seam that preserves the Bash tool's
identity and execution contract.

**Verification.** Package tests load the provider through DSH's real skill
registry, compare its loaded content with `skill-doc/SKILL.md`, and verify that
every referenced resource is available from the provider's resource base. The
pack verification confirms that the published package contains the complete
skill tree. A DSH end-to-end session must be able to discover and load the
bundled skill, request the normal Bash permission when required, and complete a
real Obelisk query without a separate global skill installation.

**Consequences.** Obelisk guidance remains single-source and consistent across
agent harnesses. DSH retains its native retrieval, execution, permission, and
presentation behavior, while users may opt into cross-harness history through
the plugin. Canonical skill changes reach the integration through the package
build instead of a second maintained instruction set. The initial integration
has no dedicated tool card or settings page; those surfaces remain available
for future plugin-owned capabilities with their own stable contracts.
