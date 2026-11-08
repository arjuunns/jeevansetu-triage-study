# Data

These files come from two open-access PhysioNet datasets, both released under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/):

- `mimic-iv-ed/`: MIMIC-IV-ED Demo, version 2.2. Johnson, A., Bulgarelli, L., Pollard, T., Celi, L. A., Mark, R., and Horng, S. (2023). *MIMIC-IV-ED Demo* (version 2.2). PhysioNet. https://doi.org/10.13026/jzz5-vs76
- `mimic-iv-demo/hosp/patients.csv.gz`: MIMIC-IV Clinical Database Demo, version 2.2. Johnson, A., Bulgarelli, L., Pollard, T., Horng, S., Celi, L. A., and Mark, R. (2023). *MIMIC-IV Clinical Database Demo* (version 2.2). PhysioNet. https://doi.org/10.13026/dp1f-ex47

Please also cite PhysioNet: Goldberger, A., et al. (2000). PhysioBank, PhysioToolkit, and PhysioNet. *Circulation*, 101(23), e215–e220.

`mimic_ed_cohort.json` is built from these files by `research/build_cohort.py` and is shared under the same licence. These are the demo datasets, not the full MIMIC-IV-ED, which needs credentialed access and may not be redistributed.
