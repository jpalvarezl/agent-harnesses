---
description: Check for duplicate classes between generated models and openai-java, then suppress actionable duplicates
---
Verify whether generated classes in this project duplicate openai-java models.

Inputs:
- Generated source root: $1
- openai-java dependency (group:artifact) or pom module: $2

Steps:
1. Use the `dup-classes` skill to identify duplicates. Categorize each as:
   - **Actionable** (standalone, can be suppressed) vs **Structural** (hierarchy member, cannot be suppressed)
2. Generate a DUPLICATES.md report with the findings.
3. If actionable duplicates are found, ask the user if they want to proceed with suppression.
4. If yes, use the `dedup-openai` skill to suppress them via @@alternateType in TypeSpec.
