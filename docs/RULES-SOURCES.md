# Corredor: Rules and Their Sources

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) §6 and the rules pack itself, [`src/corredor/rules/rules.json`](../src/corredor/rules/rules.json). This is the document we use to defend each rule in front of judges.

**Verified:** 2026-10-17.

**Method.** For each regulation, one agent read the regulator's own text first: BCB normativos, DOF/Banxico, Boletín Oficial/CNV, the BCRA API, OFAC and eCFR. A second, independent agent then tried to refute every finding against the same primary texts. Where the two disagreed, this document uses the second agent's final verdict. Secondary sources (law-firm notes, blogs, press) are named as secondary and are never the only support for a rule.

**Standing caveat.** This is a hackathon demo, not legal advice. Every provider in the demo (PagaFX, Ponte Digital, Sol VASP, Puente MX, Banco Azul, Pampa PSAV, Cueva P2P) is fictional. The rules pack is sourced but still **pending human compliance review**. Where a block is our own company policy rather than a legal prohibition, the rule message says so.

---

## 1. Summary

Verdict is the state of the rule **before** the Oct 17 fix: **accurate**, **minor fix** (right idea; wrong date, wording or source) or **materially wrong** (the old rule claimed something the law doesn't say). Two rules are new.

| Rule | What it does | Instrument and article | Effective | Verdict before fix | Primary URL |
|---|---|---|---|---|---|
| BR-521-FX | Stablecoin routes need a BCB purpose code and the payee's tax ID (`require_fields`) | Res. BCB 521/2025, adding arts. 76-A, 76-B and 76-C to Res. BCB 277; art. 6 | 2026-05-04 → (FX classification itself from 2026-02-02) | Minor fix | [BCB Res. 521](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=521) |
| BR-521-CAP | Blocks a non-bank VASP route above US$100k | Res. BCB 277 art. 29, IV (added by Res. 521) | 2026-02-02 → | Minor fix | [BCB Res. 521](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=521) |
| BR-561-EFX | Blocks eFX providers as off-ramps | Res. BCB 561/2026 art. 1 (new art. 50, I of Res. 277) and art. 4 | 2026-10-01 → | Minor fix | [BCB Res. 561](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=561) |
| BR-VASP-PENDING-WARN | Warns on an off-ramp that filed for BCB authorization and is waiting | Res. BCB 520 art. 88 I and §6; IN BCB 704 art. 9; Res. BCB 548/2026 | 2026-02-02 → (open-ended) | Materially wrong | [BCB Res. 520](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=520) |
| BR-VASP-UNFILED-WARN | **New.** Warns on an off-ramp that is operating but hasn't filed yet | Res. BCB 520 art. 88 I and §7; IN BCB 704 art. 9 | 2026-02-02 → 2026-10-30 | New | [BCB Res. 520](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=520) |
| BR-VASP-AUTH | Blocks an off-ramp that missed the filing deadline | Res. BCB 520 art. 88 §7; art. 91 as amended by Res. BCB 589/2026 | 2026-10-31 → | Materially wrong | [BCB Res. 520](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=520) |
| BR-VASP-ART91 | **New.** Warns that banks may not deal with non-authorized VASPs | Res. BCB 589/2026 art. 1 (new art. 91 of Res. 520) | 2026-11-06 → | New | [BCB Res. 589](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=589) |
| MX-BANK-CRYPTO | Blocks a Mexican bank as off-ramp | Banxico Circular 4/2019, rule 3.a | 2019-03-09 → | Minor fix | [DOF 08-03-2019](https://dof.gob.mx/nota_detalle.php?codigo=5552303&fecha=08/03/2019) |
| AR-PSAV | Blocks an off-ramp that isn't in the CNV PSAV registry | Normas CNV Tít. XIV Cap. III arts. 1, 3 and 4 (as replaced by CNV RG 1172/2026); Ley 27.739 art. 37 | 2024-03-25 → | Minor fix | [B.O. 15-10-2026, RG 1172](https://www.boletinoficial.gob.ar/detalleAviso/primera/348986/20261015) |
| AR-FX-SPREAD | Warns when USDT/ARS is more than 5% above the BCRA wholesale rate (business risk, not law) | BCRA Com. A 3500 reference rate (official leg only) | always | Minor fix | [BCRA API, A 3500](https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD) |
| VE-OFAC | Holds every Venezuela payout for a human sanctions review (company policy) | 31 CFR 591.201 and 591.406; EO 13884; OFAC FAQ 680 | always | Materially wrong | [OFAC FAQ 680](https://ofac.treasury.gov/faqs/680) · [program page](https://ofac.treasury.gov/sanctions-programs-and-country-information/venezuela-related-sanctions) |

**Who the rules bind.** Almost none of these rules binds the paying company directly. They bind the off-ramp or the local bank: the Brazilian VASP or eFX provider, Brazilian banks and payment institutions, Mexican banks and fintechs, Argentine PSAVs. OFAC binds U.S. persons. Corredor screens on the payer's side so the payer doesn't send money through a counterparty that can't lawfully take it. Where we block more than the law requires, the rule says it is **Corredor policy**.

---

## 2. Brazil

All BCB links open the regulator's page, which is a JavaScript app. The text is also served by the BCB normativos API, which is where both agents read it.

### BR-521-FX: stablecoin payment = FX operation (purpose code + client ID)

**What the law says.** Res. BCB 521 (adopted 10 Nov 2025, DOU 11 Nov 2025) brings virtual-asset services into Brazil's FX rulebook, Res. BCB 277. The new art. 76-A lists the activities that now count as FX:

> "Art. 76-A. Está incluída no mercado de câmbio a prestação de serviços de ativos virtuais que compreenda as seguintes atividades ou operações: I - pagamento ou transferência internacional com ativos virtuais; ... IV - compra, venda ou troca de ativos virtuais referenciados em moeda fiduciária."

*International payments with virtual assets, and buying, selling or swapping stablecoins, are part of the FX market.*

Art. 76-B(I) covers our case: ownership of the stablecoin changes between a non-resident (the U.S. payer) and a resident (the Brazilian supplier). Art. 76-C sets the data duty:

> "Art. 76-C. Para a realização das operações de que trata o art. 76-B, a prestadora de serviços de ativos virtuais deve: I - obter do cliente a informação sobre a finalidade do pagamento ou transferência, apresentando ou tornando disponível ... os códigos constantes dos Anexos III ou IV, considerando o equivalente a US$50.000,00 ... como limite por pagamento ou transferência para uso do Anexo III; ... III - obter do cliente as informações constantes do Anexo VI sobre o pagador ou recebedor no exterior e sua relação de vínculo com o cliente;"

*The VASP must get from its client the payment's purpose code (Annex III up to US$50k per payment, Annex IV above that) and details of the payer abroad.*

**Who it binds.** The Brazilian VASP. It collects the data from its client (the supplier). The payer only supplies data in practice.

**Effective dates.** Res. 521 art. 6 phases in: everything else from **2 Feb 2026**; art. 76-C (the purpose-code duty) and art. 82-A (reporting) from **4 May 2026**. Res. BCB 574 (DOU 22 Jun 2026) then postponed monthly reporting to the BCB to operations from **3 Nov 2026**, and IN BCB 756 (DOU 3 Jul 2026) set the first data-base to November 2026. The duty to *collect* the purpose code was not postponed.

**What we changed and why.**
- `effectiveFrom` moved from 2026-02-02 to **2026-05-04**, because this rule enforces the purpose code, which comes from art. 76-C.
- The message now says the CNPJ/CPF is needed for client identification under Circular 3.978, not "for BCB reporting" (reporting only starts with operations from 3 Nov 2026).
- The source changed from fcm.law (secondary, and stale on reporting dates) to the BCB text.
- The demo invoice had a placeholder purpose code. It now carries **46978**, "Serviço de negócio" in Res. 277 Annex III. That is the right Annex III code for about US$15.7k of design services (R$85,000 at 5.40).

**Still open.**
- The engine only checks that a purpose code is present, not that it is a valid 5-digit Annex III or IV code.
- We don't model the Annex VI relationship code (40 same group / 50 other). The payer knows it, so the system could fill it in.
- Res. 277 art. 76-A §3 bars moving "recursos de interesse de terceiro" through these services. If the supplier receives its own payment, this is fine. A foreign aggregator acting for many payers might not be.
- Nothing in this rule rests only on secondary sources.

Other primary links: [Res. 277 (consolidated, Annexes III and VI)](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=277) · [Res. 574](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=574) · [IN 756](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Instru%C3%A7%C3%A3o%20Normativa%20BCB&numero=756)

### BR-521-CAP: US$100k cap per international stablecoin payment (non-bank VASP)

**What the law says.** Res. 521 rewrote Res. 277 art. 29, which says what each type of FX-authorized institution may do:

> "IV - sociedades prestadoras de serviços de ativos virtuais: operações de prestação de serviços de ativos virtuais previstas nesta Resolução, vedadas operações envolvendo moedas em espécie, nacional ou estrangeira, observado que o pagamento ou transferência internacional com ativos virtuais quando a contraparte não for instituição autorizada a operar no mercado de câmbio é limitado ao valor equivalente a US$100.000,00 (cem mil dólares dos Estados Unidos)."

*A non-bank VASP (SPSAV) may not make an international payment or transfer with virtual assets above US$100,000 when the counterparty is not an institution authorized to operate in Brazil's FX market.*

The cap depends on the institution type: SPSAVs US$100k (art. 29 IV); brokers, dealers and finance companies acting as VASPs US$500k (art. 29 II(c)); banks and Caixa no cap (art. 29 I). Incumbent VASPs still waiting for authorization operate under art. 29 §5 as SPSAVs, so the same cap applies to them.

**Who it binds.** The Brazilian VASP, not the payer.

**Effective dates.** 2 Feb 2026 (Res. 521 art. 6, II). No 2026 amendment to art. 29 IV. Res. 539/2025 changes other items of art. 29 only from 1 Jun 2027.

**What we changed and why.** The logic, the threshold and the strict `>` comparison were already right. We rewrote the title and message to use the article's own terms, and replaced the source: the old one (Stablecoin Insider) doesn't mention US$100k at all. `offrampTypes` now includes the new `vasp_unfiled` type, so the cap still applies to Ponte Digital after its reclassification.

**Still open.**
- **"Per payment" is our reading.** The text is singular ("o pagamento ou transferência ... é limitado"), and art. 29 §1 I lets installments of a larger deal go through. The BCB has published no FAQ on whether a VASP must add together several payments to the same client. We never split invoices to get under the cap; that could look like structuring under Circular 3.978.
- The US$500k broker cap isn't modelled. Banks are correctly outside `offrampTypes`.
- Nothing in the final rule rests only on secondary sources.

### BR-561-EFX: eFX providers can't settle with foreign counterparties in virtual assets

**What the law says.** Res. BCB 561 (30 Apr 2026, DOU 5 May 2026, Seção 1, pp. 188–189) rewrote the eFX title of Res. 277. New art. 50:

> "O pagamento ou recebimento entre prestador de eFX e sua contraparte no exterior deve ser realizado exclusivamente: I - por meio de operação de câmbio ou de movimentação em conta em reais de não residente mantida no Brasil, sendo vedado o uso de ativos virtuais"

*An eFX provider must settle with its counterparty abroad only through an FX contract or a non-resident BRL account; using virtual assets is prohibited.*

The same ban is repeated for providers in transition (art. 56-B §2). There is no transition period for the virtual-asset ban.

**Who it binds.** The eFX provider. FX banks must monitor it (art. 50-B III). It does not bind the payer. The same company may still make cross-border virtual-asset payments in its **VASP** capacity under Res. 521, subject to the US$100k cap and the third-party ban in art. 76-A §3.

**Effective dates.** In force **1 Oct 2026** (art. 4). Not revoked, and art. 50 has not changed since.

**What we changed and why.** The message now cites the exact article. The source changed from an Eco help-center article to the BCB text. The Eco article said "published 30 April" (the signing date; DOU publication was 5 May) and "regulated fintechs and eFX providers" (the text names only eFX providers).

**Related, not modelled.**
- Art. 49 I b caps non-e-commerce eFX digital payments at US$10k after Oct 1.
- Art. 56-A: existing eFX providers must register the eFX modality in Unicad by **30 Oct 2026**. This is a second, unrelated Oct 30 deadline.
- Art. 56-B: other providers must apply for payment-institution authorization by 31 May 2027.

**Still open.** Before Oct 1, eFX settlement in stablecoins was **not expressly prohibited**, which is a grey area. We do not claim it was "legal". Confidence on the text and dates is high.

### BR-VASP-PENDING-WARN: off-ramp's BCB authorization request is pending

**What the law says.** Res. BCB 520 (DOU 11 Nov 2025; in force 2 Feb 2026 per art. 92) gives VASPs that were already operating 270 days to **file** for authorization:

> "Art. 88. As sociedades que, na data da entrada em vigor desta Resolução, estiverem realizando uma ou mais das atividades ... devem: I - solicitar autorização para funcionamento no Brasil, no prazo máximo de duzentos e setenta dias contados a partir da data da entrada em vigor desta Resolução"

*Providers already operating must apply for authorization within 270 days of 2 Feb 2026, which is 30 Oct 2026.*

IN BCB 704 art. 9 confirms the date: phase 1 "deve ser instruído, até 30 de outubro de 2026". A provider that files on time may keep operating:

> "§ 6º As sociedades prestadoras de serviços de ativos virtuais que apresentarem tempestivamente o pedido de que trata o inciso I do caput podem manter a prestação dos serviços de ativos virtuais até a conclusão do seu processo de autorização, sendo vedada a assunção de outra modalidade nesse período."

*A provider that filed on time may keep providing services until its authorization process ends.*

Res. BCB 548/2026 (DOU 23 Feb 2026) gives the BCB up to **1,080 days** to decide for incumbents (Res. 549 splits this into 360 for phase 1 and 720 for phase 2; Res. 594 re-enacted the same figures). Phase 2 is due within 60 days of a favourable phase-1 decision, extendable by 60 (IN 704 art. 10). For cross-border payouts, the incumbent's request must also cover the FX market (Res. 277 art. 29 §5, added by Res. 521).

**Who it binds.** The VASP.

**Effective dates.** From 2 Feb 2026, with no end date: a timely filer can stay "pending" for up to 1,080 days.

**What we changed and why.** The old rule said the off-ramp "must be authorized by Oct 30, 2026" and stopped warning on Oct 29. Both were wrong: Oct 30 is the deadline to **file**, and a timely filer stays lawful after it. `effectiveTo` is now `null`, and the message cites art. 88 §6, Res. 548 and art. 29 §5. The researcher had said "the BCB has no fixed deadline to decide"; the verifier refuted that with Res. 548, so the message gives the 1,080-day figure.

**Still open.** From 6 Nov 2026 the amended art. 91 may also cut pending filers off from Brazilian banks (see BR-VASP-ART91). No demo provider is `vasp_pending`, so this rule doesn't fire in the demo; it covers real-world filers.

Other primary links: [IN BCB 704](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Instru%C3%A7%C3%A3o%20Normativa%20BCB&numero=704) · [Res. BCB 548](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=548) · [Res. BCB 519](https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=519)

### BR-VASP-UNFILED-WARN: off-ramp has not filed for BCB authorization (new)

**What the law says.** Same art. 88 I and IN 704 art. 9 as above: providers already operating must file by 30 Oct 2026. Until that date, operating without having filed is lawful. If they don't file, art. 88 §7 applies (see BR-VASP-AUTH).

**Who it binds.** The VASP.

**Effective dates.** 2 Feb 2026 to **30 Oct 2026 inclusive**. Oct 30 is still a valid filing day ("até 30 de outubro de 2026").

**Why we added it.** The old pack had no type for "operating, but not yet filed". That is exactly Ponte Digital's situation in the new demo storyline. It is lawful, so it's a warning, not a block. New offramp type: `vasp_unfiled`.

**Still open.** Nothing in this rule rests on secondary sources.

### BR-VASP-AUTH: missed the Oct 30 BCB filing deadline

**What the law says.** A provider that doesn't file on time must wind down:

> "§ 7º As sociedades prestadoras de serviços de ativos virtuais que não protocolarem tempestivamente o pedido de que trata o inciso I do caput devem cessar a prestação de serviços de ativos virtuais em até trinta dias após o fim do prazo previsto no referido dispositivo."

*Providers that don't file on time must stop virtual-asset services within 30 days after the deadline, so by about 29 Nov 2026.*

Separately, from 6 Nov 2026 Brazilian banks and payment institutions may not deal with VASPs that are not authorized (amended art. 91). A non-filer is neither authorized nor pending, so it is caught under any reading of art. 91.

**Who it binds.** Art. 88 binds the VASP. Art. 91 binds Brazilian banks and payment institutions. Neither binds a foreign payer, but both cut off the off-ramp's Pix payout leg.

**Effective dates.** We block from **2026-10-31**. The legal cease date is about 29 Nov 2026; the bank ban starts 6 Nov 2026.

**What we changed and why.** The old rule blocked `vasp_pending` providers from Oct 30 because "the transition period" ended. No such transition period exists, and blocking a timely filer contradicts art. 88 §6. The rule now applies only to `vasp_unfiled` providers, starts on Oct 31 and is titled "Missed the Oct 30 BCB filing deadline". **Blocking on Oct 31 is Corredor policy, not a legal ban on that day**, and the message says so: the provider is in mandatory wind-down and can no longer file on time.

**Still open.**
- The Nov 29 date assumes the deadline ends at the close of Oct 30.
- No SPSAV had been authorized as of mid-October 2026. That count comes only from secondary sources (Blue Consult, about 2 Oct 2026); applicant counts vary by source (5 to 7). Onda Finance appears as an applicant in a BCB Comunicado (no. 45.986, 21 Sep 2026) but isn't authorized. We found no public BCB list of filed or authorized SPSAVs. So **Sol VASP being "authorized" is hypothetical**. A bank acting as VASP under Res. 520 arts. 20 and 22 is today's realistic authorized route.

### BR-VASP-ART91: banks may not deal with non-authorized VASPs from Nov 6 (new)

**What the law says.** Res. BCB 589 (23 Sep 2026, DOU 25 Sep 2026, Seção 1, p. 84; this change in force 1 Oct 2026) rewrote Res. 520 art. 91:

> "Art. 91. É vedado, a partir de 6 de novembro de 2026, às instituições financeiras, às instituições de pagamento e às demais instituições autorizadas a funcionar pelo Banco Central do Brasil realizar ou viabilizar operações no mercado de ativos virtuais que tenham como contrapartes instituições ou entidades que prestem serviços de ativos virtuais e não estejam autorizadas a funcionar no país por essa Autarquia, exceto nas formas expressamente autorizadas nesta Resolução."

*From 6 Nov 2026, Brazilian banks, payment institutions and other BCB-authorized institutions may not carry out or enable virtual-asset operations with VASPs that are not authorized to operate in Brazil.*

The original art. 91 started on 30 Oct 2026 and covered VASPs "não estejam autorizadas **ou em processo de autorização**", so pending filers were exempt. Res. 589 moved the date to 6 Nov and **dropped those words**. The unchanged sole paragraph extends the ban to payment accounts and payment transactions when they serve those operations, which likely means Pix.

**Who it binds.** Brazilian banks and payment institutions.

**Effective dates.** From 6 Nov 2026.

**Why we added it.** It's a real, dated change that could cut the Pix leg of a pending off-ramp. We **warn** rather than block because the reading is contested.

**Contested.**
- BCB's own press note of 23 Sep 2026 still describes the change as a deadline for institutions to stop dealing with entities "que não estejam autorizadas **ou em processo de autorização**". So the literal text and the BCB's description conflict.
- We found no BCB FAQ or clarification as of 17 Oct 2026. Blue Consult (2 and 14 Oct 2026) and Transfero (5 Oct 2026) also call it unresolved. Confidence on this point is medium.
- The rule tells the operator to confirm the off-ramp's Pix/BRL banking partner before paying.
- It doesn't fire in the demo: no provider is `vasp_pending`, and the slider doesn't go past Oct 31.

Links: [BCB press note, 23 Sep 2026](https://www.bcb.gov.br/detalhenoticia/21267/nota) (read via a mirror PDF; the BCB page is a JS app) · secondary: [Blue Consult, 2 Oct](https://blueconsult.com.br/fila-banco-central-pedidos-psav-pix-stablecoin/) · [Blue Consult, 14 Oct](https://blueconsult.com.br/banco-encerra-conta-psav-nao-autorizada/) · [Transfero, 5 Oct](https://transfero.com/pt/artigos/prazo-autorizacao-psav-30-outubro)

---

## 3. Mexico

### MX-BANK-CRYPTO: banks can't offer crypto services to clients

**What the law says.** Banxico Circular 4/2019, rule 3.a:

> "Las Instituciones solo podrán celebrar las Operaciones con Activos Virtuales que correspondan a Operaciones Internas, sujeto a la previa autorización otorgada por el Banco de México ... deberán impedir en todo momento que se transmita, directa o indirectamente, el riesgo ... a los Clientes ... No serán elegibles ... aquellas Operaciones ... mediante las cuales pretendan prestar de manera directa a sus Clientes servicios de intercambio, transmisión o custodia de activos virtuales."

*Banks and fintech institutions may use virtual assets only for internal operations Banxico authorizes, must never pass the risk to clients, and can never offer clients exchange, transfer or custody of virtual assets.*

Paying a client pesos for USDC is such a service, so a Mexican bank can't be the off-ramp. Ley Fintech arts. 30 and 88 back this up.

**Who it binds.** Mexican credit institutions (banks) and fintech institutions (ITFs). Not the payer. SAT's 2026 FAQ 1.11 confirms that buying virtual assets doesn't make you an obligated party.

**Effective dates.** Published in the DOF on 8 Mar 2019 and in force the next day ("entrará en vigor al día siguiente al de su publicación"), so **2019-03-09**. Its only amendment is Circular 37/2020 (DOF 30 Sep 2020).

**What we changed and why.**
- `effectiveFrom` moved from 2019-03-08 to **2019-03-09**.
- The message no longer says "licensed non-bank". **Mexico has no crypto license**, and licensed ITFs are under the same restriction as banks. The compliant route is a non-bank platform that is **registered with SAT** as a vulnerable activity under LFPIORPI art. 17-XVI and reports to the UIF.
- The source changed from iProUP, which credits the CNBV rather than Banxico, cites no primary document and wrongly calls Bitso, OKX and Binance Mexico CNBV-authorized ITFs, to the DOF text.
- The old PRD row said "reaffirmed Jun 2026". We found no primary 2025–2026 Banxico or CNBV statement, so that's gone.

**Still open.**
- **Next change: SHCP Acuerdo 115/2026** (DOF 7 Aug 2026) takes effect **30 Nov 2026**. It creates a SAT "alta y registro de proveedores de servicios de activos virtuales" and sets travel-rule data fields (art. 24 Bis 2). Its art. 24 Bis 4 treats even peso-only intermediaries that connect or match crypto trades as facilitators. A judge could ask whether that reaches Corredor (see Q&A).
- The travel-rule duty is in the 2025 statute, but its detailed content (Acuerdo 115) is not in force on Oct 17.
- Whether a USD stablecoin is even an "activo virtual" under Ley Fintech art. 30 (which excludes currency-denominated assets) is a question for counsel. SAT and exchanges treat it as one.
- Not confirmed: whether Banxico has ever granted an internal-operations authorization; the CNBV ITF registry (unreachable); the "rule 11.a" description of Circular 37/2020.
- A "September 2026 joint statement" seen in search summaries couldn't be traced to any primary source. It looks like a mix-up with the 28 Jun 2021 joint statement.
- The Murat stablecoin bill (May 2026) and the Digital Economy law (passed the Chamber 6 Oct 2026) are not law. Our sources for both are secondary only.

Other primary links: [Banxico Circular 4/2019 page](https://www.banxico.org.mx/marco-normativo/normativa-emitida-por-el-banco-de-mexico/circular-4-2019/circular-4-2019.html) · [Ley Fintech](https://www.diputados.gob.mx/LeyesBiblio/pdf/LRITF.pdf) · [LFPIORPI](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPIORPI.pdf) · [Banxico/SHCP/CNBV joint statement, 28 Jun 2021](https://www.banxico.org.mx/publicaciones-y-prensa/miscelaneos/%7B56A7FE3D-C30E-86ED-E5C9-D9876D47D21E%7D.pdf) · [SAT FAQ 2026](https://www.sat.gob.mx/minisitio/ActividadesVulnerables/documentos/Preguntasfrecuentes2026.pdf) · [Acuerdo 115/2026](https://dof.gob.mx/nota_detalle.php?codigo=5795797&fecha=07/08/2026)

---

## 4. Argentina

### AR-PSAV: off-ramp must be a CNV-registered PSAV

**What the law says.** Ley 27.739 (B.O. 15 Mar 2024) defines a PSAV and gives the CNV the registry and sanctioning power (art. 37). CNV RG 1172/2026 (signed 14 Oct 2026, B.O. 15 Oct 2026, in force **16 Oct 2026**) replaces the whole PSAV chapter of the CNV Normas (Tít. XIV Cap. III). The new chapter's art. 3 says:

> "Toda persona humana o jurídica que no se encuentre inscripta en el Registro, en los términos indicados en el artículo 1 precedente, deberá abstenerse de realizar en el país cualquiera de las actividades u operaciones comprendidas en la Definición de PSAV. Los incumplimientos a la normativa serán pasibles de sanciones de acuerdo con lo dispuesto en el artículo 37 de la Ley N° 27.739."

*Anyone not in the PSAV registry must not carry out PSAV activities in Argentina, and can be sanctioned under Ley 27.739 art. 37.*

Exclusions (new chapter art. 2) include anyone who receives or pays crypto as payment for their goods or services ("cualquiera sea el monto"), so **our Argentine supplier doesn't need to register**. Individuals only need to register above UVA 35,000 per calendar month (art. 1), about ARS 75.6M or roughly US$50k at UVA 2,159.1 on 17 Oct 2026. Foreign providers must register if they target Argentina (art. 4): a .ar domain, local partners taking residents' funds (named explicitly as "servicios de rampa"), advertising aimed at residents, or Argentine operations above 20% of volume.

Banks: BCRA Com. "A" 7506 (May 2022) says banks "no pueden realizar ni facilitar a sus clientes la realización de operaciones con activos digitales" not authorized by a competent regulator. Com. "A" 7759 (May 2023) applies the same ban to payment-account providers (fintech wallets / CVU). Neither stops a bank from receiving pesos that a PSAV pays out to a CBU or CVU.

**Who it binds.** The provider. The CNV puts no direct duty on a foreign payer; the payer's exposure is AML/KYC and reputational.

**Effective dates and transitions.**
- RG 994/2024: registry created and the abstain duty in force **25 Mar 2024**. Providers already operating had 45 days to **apply**.
- RG 1058/2025 (B.O. 14 Mar 2025): full regime in force 28 Apr 2025. Re-filing deadlines were 1 Jul, 1 Aug and 1 Sep 2025; all other rules applied to existing registrants from 31 Dec 2025.
- RG 1172/2026: chapter replaced from 16 Oct 2026. It adds a mixer ban and a monthly report (PSAV_014) from 1 Nov 2026.

**What we changed and why.**
- `effectiveFrom` set to 2024-03-25 (it was `null`).
- The citation now points to the new chapter's art. 3 "as replaced by RG 1172/2026". Art. 3 of RG 1172 itself only amends a sanctions item; the abstain text is art. 3 of the new chapter.
- The message no longer says "Argentine banks can't touch crypto". It now says they "may not offer or facilitate" crypto.
- The source changed from Stablecoin Insider (secondary, says nothing about banks, predates RG 1172) to the Boletín Oficial.

**Still open.**
- **RG 994's 45-day count.** The text says "CUARENTA Y CINCO (45) días" without "corridos". Counted as calendar days, the window ended about 9 May 2024. Under Ley 19.549 administrative filing deadlines count business days, which would put it around late May 2024. This doesn't affect the demo, so don't quote a specific end date.
- **A 7506 and A 7759 still in force.** bcra.gob.ar returned HTTP 502 on 17 Oct 2026, so we read archived copies of the original PDFs. No repeal was found. The "still applies in 2026" confirmation (Superintendent Curutchet on 7–8 Oct 2026: "este año no va a pasar") is secondary only.
- **Our type `p2p_unregistered` covers two cases.** An individual P2P seller under the UVA threshold is lawfully unregistered; a P2P business that isn't registered is in breach. Blocking both is our corporate **policy**, so a KYC and AML trail exists.
- Not checked: whether the supplier must sell export proceeds in the official FX market (MLC). That's the supplier's FX-regime question, not a CNV one.

Other primary links: [RG 994/2024](https://www.boletinoficial.gob.ar/detalleAviso/primera/305110/20240325) · [RG 1058/2025](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-1058-2025-410635/texto) · [BCRA A 7506 (archived)](https://web.archive.org/web/2024id_/https://www.bcra.gob.ar/Pdfs/comytexord/A7506.pdf) · [BCRA A 7759 (archived)](https://web.archive.org/web/20240115145632id_/http://www.bcra.gob.ar/Pdfs/comytexord/A7759.pdf) · [CNV PSAV registry](https://www.cnv.gov.ar/SitioWeb/RegistrosPublicos/PSAV)

### AR-FX-SPREAD: USDT/ARS rate vs. BCRA official rate

**What the law says.** Nothing. This is a **business-risk warning, not a legal rule**, and the message now opens with those words. Context: BCRA Com. "A" 8226 lifted FX controls for individuals from 14 Apr 2025. Controls on companies remain (secondary sources only), and the peso floats within a band.

**The numbers (snapshot of 16 Oct 2026).**

| Rate | ARS per USD | vs. wholesale | Source |
|---|---|---|---|
| BCRA Com. A 3500 wholesale (official leg) | 1,518 | — | [BCRA API](https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD) (primary) |
| Blue | about 1,555 | +2.4% | press, dolarapi.com (secondary) |
| MEP | about 1,540 | +1.2–1.6% | press, dolarapi.com (secondary) |
| CCL | about 1,620 | +6.3–6.8% | press, dolarapi.com (secondary) |
| **USDT/ARS (crypto)**, our "parallel" leg | **1,619** | **+6.7%** | dolarapi.com (secondary) |

`data/fx.json` now uses 1,518 and 1,619, so the warning reads "Official 1,518 vs. market (USDT) 1,619 ARS/USD (6.7% gap)".

**Who it binds.** No one. It tells the operator to agree with the supplier which rate converts a peso invoice.

**What we changed and why.**
- The old demo rates (1,350 / 1,460, an 8.1% gap) were about a year stale.
- The old "official vs. parallel" framing doesn't hold today: blue and MEP are only 1–2.5% above official and would not trigger a 5% warning. The rate that matters for a USDT off-ramp is USDT/ARS.
- The old source (an Eco help article) itself said crypto rates were 4–6% above official, which contradicted our 8.1% gap.

**Still open.**
- The USDT leg has no regulator source; dolarapi.com is a secondary aggregator. The UI should name both legs.
- **The 5% threshold is fragile.** The USDT gap was 5.66% on 11 Oct. If "official" were the BNA retail sell rate (1,535) instead of wholesale, the gap would be about 5.5%. Always say "wholesale".
- Whether the gap helps or hurts depends on the invoice currency. On a USD invoice the supplier gets more pesos via USDT. On a peso invoice, converting at the official rate overpays in USD.

---

## 5. Venezuela

### VE-OFAC: Venezuela OFAC sanctions review hold

**What the law says.** Venezuela is under **targeted** OFAC sanctions, not a country-wide embargo. OFAC FAQ 680:

> "U.S. persons are not prohibited from engaging in transactions involving the country or people of Venezuela, provided blocked persons or any conduct prohibited by any other Executive order imposing sanctions measures related to the situation in Venezuela, are not involved."

FAQ 519: "the Venezuelan people are not subject to comprehensive U.S. sanctions."

What **is** blocked:
- the Government of Venezuela under EO 13884: its agencies, the central bank, PdVSA, anyone owned or controlled by it, and anyone acting for it;
- SDNs;
- any entity 50% or more owned by blocked persons, even if it isn't on the SDN List (31 CFR 591.406).

Also prohibited:
- dealings in certain Government of Venezuela and PdVSA debt and equity (EO 13808);
- digital currency issued by the Government of Venezuela, i.e. the petro (EO 13827). USDC and USDT are not covered.

If quoting EO 13884 sec. 6(d) on stage, use the exact text:

> "the term ``Government of Venezuela'' includes the state and Government of Venezuela, any political subdivision, agency, or instrumentality thereof, including the Central Bank of Venezuela and Petroleos de Venezuela, S.A. (PdVSA), any person owned or controlled, directly or indirectly, by the foregoing, and any person who has acted or purported to act directly or indirectly for or on behalf of, any of the foregoing, including as a member of the Maduro regime."

**Who it binds.** U.S. persons (citizens, permanent residents, U.S. companies including foreign branches, anyone in the U.S.) and transactions with a U.S. nexus. A non-U.S. payer is exposed through USD stablecoin issuers, U.S. banks, and "material assistance" designation risk under EO 13884 sec. 1(b).

**Status as of 17 Oct 2026.**
- Sanctions were eased a lot in 2026, but **only through general licenses**. No blocking or prohibition EO was revoked.
- The national emergency was continued for one year on 18 Feb 2026 (91 FR 8357). It must be renewed by about 8 Mar 2027.
- GL 57 (14 Apr 2026) authorizes financial services involving the central bank, Banco de Venezuela, Banco del Tesoro and Banco Digital de los Trabajadores. GL 60A came out on 16 Oct 2026, the day before the pitch.
- Delcy Rodríguez (1 Apr 2026) and Jorge Rodríguez (14 Oct 2026) were removed from the SDN List. Our SDN snapshot (`data/sdn.csv`, "OFAC SDN 2026-10-17" per `data/sdn.meta.json`) reflects both removals and still lists Maduro.

**What we changed and why.** The old message, "Hard stop: Venezuela sanctions. Requires a named OFAC general license and compliance sign-off.", implied every Venezuelan payment needs a license. FAQ 680 says the opposite for non-blocked private parties. The `block` outcome stays, reframed as a **company policy hold pending sanctions review**. An AP agent can't verify ownership chains or state links on its own, so a human confirms that the payee, its owners and the receiving bank or off-ramp are not blocked, or are covered by a general license. The id, check and outcome didn't change.

**Still open.**
- **Maduro's capture (3 Jan 2026).** The researcher found only secondary sources (Wikipedia). The verifier found a U.S. Department of War news article, ["Trump Announces U.S. Military's Capture of Maduro"](https://www.war.gov/News/News-Stories/Article/Article/4370431/trump-announces-us-militarys-capture-of-maduro/), and a UK House of Commons Library briefing (CBP-10452) in search results, **but did not open them**. Don't build an answer on the capture; the sanctions analysis doesn't depend on it.
- EO 14245 (tariffs on countries importing Venezuelan oil) is no longer in effect, per EO 14389 of 20 Feb 2026. So "every Venezuela EO is fully in force" is slightly overstated. Say "no blocking or prohibition EO was revoked".
- EO 14373 was signed 9 Jan 2026 and published 15 Jan 2026.
- OFAC FAQ 1263 still says "GL 48C", but the program page lists GL 48D (28 Sep 2026) as current. Cite 48D.
- General licenses are changing almost daily. **Re-check the OFAC program page right before the pitch.**
- The message assumes the payer is a U.S. person or has a U.S. nexus.

Other primary links: [OFAC FAQ 519](https://ofac.treasury.gov/faqs/519) · [31 CFR 591 (eCFR)](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-V/part-591) · [EO 13884 (Federal Register)](https://www.federalregister.gov/documents/2019/08/07/2019-17052/blocking-property-of-the-government-of-venezuela) · [EO 13884 exact text (govinfo)](https://www.govinfo.gov/content/pkg/FR-2019-08-07/html/2019-17052.htm) · [GLs 52–58 incl. GL 56 and 57](https://www.federalregister.gov/documents/2026/09/30/2026-20008/publication-of-venezuela-sanctions-regulations-web-general-licenses-52-53-54-55-56-57-and-58) · [Continuation notice, 18 Feb 2026](https://www.federalregister.gov/documents/2026/02/20/2026-03502/continuation-of-the-national-emergency-with-respect-to-venezuela) · [OFAC recent actions, 14 Oct 2026](https://ofac.treasury.gov/recent-actions/20261014)

---

## 6. What changed in the demo

**Brazil storyline (new).** Estúdio Paulista, R$85,000:

| As-of date | Route | Status | Rule on screen |
|---|---|---|---|
| Sep 30 | PagaFX (`efx`), 0.55% | Ready | none (Res. 561 not yet in force) |
| Oct 1 – Oct 30 | Ponte Digital (`vasp_unfiled`), 0.70% | Ready ⚠ | BR-561-EFX blocks PagaFX; BR-VASP-UNFILED-WARN: "hasn't filed for authorization" |
| Oct 31 → | Sol VASP (`vasp_authorized`), 0.85% | Ready | BR-VASP-AUTH blocks Ponte: missed the Oct 30 filing deadline |

**Why Oct 30 is a filing deadline.** Res. 520 entered into force on 2 Feb 2026; art. 88 I gives incumbents 270 days from that date to apply, which lands on 30 Oct 2026. IN 704 art. 9 states it outright: "até 30 de outubro de 2026". It's the last day to **file**, not to be authorized. A provider that files on time keeps operating while the BCB decides (art. 88 §6).

**Why the slider stop moved from Oct 30 to Oct 31.** On Oct 30 a provider that hasn't filed can still file that day, so blocking it on Oct 30 would be wrong. On Oct 31 it has missed the deadline: it must stop within 30 days (art. 88 §7, about Nov 29), and from Nov 6 Brazilian banks may not deal with it (art. 91). Blocking it from Oct 31 is our conservative policy, and the rule says so. A golden test checks that Oct 30 changes nothing (Ponte stays, with the warning) and that Oct 31 reroutes to Sol, naming BR-VASP-AUTH.

**Why Ponte changed type.** Ponte used to be `vasp_pending`, and the old rules blocked it on Oct 30. A timely filer can't lawfully be blocked on Oct 30, so we reclassified Ponte as a provider that **hasn't filed** (new type `vasp_unfiled`). That keeps three distinct routes on the slider and makes each one legally accurate. The US$100k cap now lists `vasp_unfiled` as well.

**Sol VASP is hypothetical.** As of mid-October 2026, public reporting shows no SPSAV authorized yet; the queue is still in phase 1 (secondary sources only). Say so on stage. In real life today, the authorized route would be a bank acting as VASP.

**Other demo data changes.**
- BR purpose code: **46978** (Res. 277 Annex III "Serviço de negócio"), replacing a placeholder.
- ARS rates: **1,518** BCRA wholesale vs **1,619** USDT/ARS (snapshot 16 Oct 2026), a 6.7% gap. Was 1,350 / 1,460 (8.1%).
- Puente MX is described as a **SAT-registered virtual-asset platform**, not "licensed". The internal type id `nonbank_licensed` is a legacy label.
- VE: still blocked on every route, now as a sanctions-review hold.

---

## 7. Judge Q&A

1. **Does Brazil ban stablecoins?** No. Res. 561 only stops **eFX providers** from settling with their foreign counterparty in virtual assets (Res. 277 art. 50, I). Cross-border stablecoin payments through a VASP are FX-market operations under Res. 521, allowed with a purpose code and, for non-bank VASPs, a US$100k cap per payment.

2. **Who is liable, you or the off-ramp?** The off-ramp or local institution in almost every case: the eFX provider (art. 50), the VASP (Res. 520 art. 88; Res. 277 art. 76-C), Brazilian banks (art. 91), Mexican banks and fintechs (Circular 4/2019), Argentine PSAVs (CNV). OFAC binds U.S. persons. We screen on the payer's side so we don't pay through a counterparty that can't lawfully take the money.

3. **Is Oct 30 the date Brazilian off-ramps must be licensed?** No. It's the last day for providers already operating to **file** (Res. 520 art. 88 I; IN 704 art. 9). Timely filers may keep operating while the BCB decides (art. 88 §6). It's also, separately, the eFX Unicad registration deadline (art. 56-A).

4. **Isn't a pending VASP unlicensed?** Not authorized yet, but lawful: a timely filer may operate until its process ends, and the BCB can take up to 1,080 days (Res. 548/2026). The open risk is the amended art. 91 from Nov 6, whose literal text no longer exempts pending applicants while the BCB's own press note still does. We warn on that (BR-VASP-ART91).

5. **Why block Ponte on Oct 31 if it legally has until Nov 29 to wind down?** Policy. Having missed the deadline, it must stop within 30 days (art. 88 §7), and from Nov 6 banks may not deal with it under any reading of art. 91. A payer shouldn't start routing money through a provider in mandatory wind-down.

6. **Is Sol VASP a real authorized provider?** No. Every provider in the demo is fictional, and as of mid-October 2026 public reporting shows no SPSAV authorized yet. Today's realistic authorized route is a bank acting as VASP.

7. **Was the PagaFX route on Sep 30 legal?** Before Oct 1, eFX settlement in stablecoins was **not expressly prohibited**, which is a grey area. From Oct 1 it is expressly prohibited (Res. 561, art. 4).

8. **Where does US$100k come from, and is it per payment?** Res. 277 art. 29 IV: a non-bank VASP's international virtual-asset payment is capped at US$100k when the counterparty isn't a Brazilian FX-authorized institution. We read it per payment because the text is singular; the BCB has no FAQ on aggregation. We never split invoices to get under it.

9. **Is the BCB already receiving the purpose-code reports?** No. Collecting the code has been mandatory since 4 May 2026 (art. 76-C). Monthly reporting starts with operations from 3 Nov 2026 (Res. 574).

10. **Is paying Venezuela illegal?** Not in general. OFAC FAQ 680 says U.S. persons may deal with the country and people of Venezuela when no blocked person is involved. What's blocked is the government (including PdVSA, the central bank, state companies and banks), SDNs, and entities 50% or more owned by them.

11. **Then why does Corredor block every Venezuela payout?** It's a company-policy hold, not a statement of law. Ownership chains and state links can't be verified by name matching, so a human confirms the payee, its owners and the receiving bank before release. Since 14 Apr 2026, GL 57 covers the named state banks.

12. **Didn't sanctions end after Maduro was removed?** No. They were eased through general licenses, but no blocking or prohibition EO was revoked, and the national emergency was continued on 18 Feb 2026. The Government of Venezuela is still blocked.

13. **Why is the Mexican off-ramp "SAT-registered" and not "licensed"?** Mexico has no crypto license. Banks and licensed fintechs are the ones *restricted* (Circular 4/2019). Exchanges operate as non-financial companies registered with SAT as a vulnerable activity (LFPIORPI art. 17-XVI) and report to the UIF. From 30 Nov 2026, Acuerdo 115/2026 formalizes that as a SAT registry of virtual-asset service providers.

14. **Is every P2P desk in Argentina illegal?** No. Individuals below UVA 35,000 a month (about US$50k) don't need to register. Unregistered PSAV *businesses* must abstain (CNV Normas Tít. XIV Cap. III art. 3, per RG 1172/2026). Requiring a registered PSAV for corporate payouts is our policy.

15. **Is the Argentine rate gap real?** Yes, against USDT. BCRA wholesale was 1,518 and USDT/ARS 1,619 on 16 Oct 2026, a 6.7% gap. Blue and MEP are only 1–2.5% above official and wouldn't trigger it. It's a business-risk flag, not a regulation.

**Hard follow-ups to be ready for:**
- *"Could Mexico's Acuerdo 115/2026 art. 24 Bis 4 catch Corredor itself?"* From 30 Nov 2026 it treats platforms that connect or match crypto trades as facilitators, even if they only handle pesos. Corredor screens and recommends; the off-ramp executes. Whether that is enough is a question for Mexican counsel.
- *"Does the Argentine supplier need a PSAV registration to receive USDT?"* No. Receiving crypto as payment for your own goods or services is outside the PSAV definition (new Cap. III art. 2, per RG 1172).

---

## 8. Words to avoid on stage

| Don't say | Say instead |
|---|---|
| "All payments to Venezuela are illegal." | "We hold Venezuela for a human sanctions review, because the government, state companies and banks, SDNs and 50%-owned entities are blocked." |
| "It needs an OFAC general license." | "Compliance confirms nobody blocked is involved, or that a general license covers them." |
| "Every P2P desk in Argentina is illegal." | "Unregistered PSAV businesses must abstain. We require a registered PSAV as company policy." |
| "Argentine banks can't touch crypto." | "Argentine banks and payment apps may not offer or facilitate crypto (BCRA A 7506 / A 7759). They can still receive pesos a PSAV pays out." |
| "Oct 30 is the authorization deadline." / "VASPs must be licensed by Oct 30." | "Oct 30 is the deadline to **file** for BCB authorization." |
| "Ponte is illegal on Oct 31." | "Ponte missed the filing deadline and must wind down by Nov 29. We block it from Oct 31 as policy." |
| "Pending VASPs lose their banks on Nov 6." | "From Nov 6 the literal text of art. 91 may reach pending VASPs, but the BCB's own note says otherwise. It's unresolved, so we warn." |
| "The Sep 30 eFX route was legal." | "Before Oct 1 it was **not expressly prohibited**." |
| "Brazil banned stablecoins." | "Brazil barred eFX providers from settling with their foreign counterparty in virtual assets." |
| "Sol VASP is BCB-authorized." (as fact) | "Sol is a fictional, hypothetical authorized VASP. No SPSAV has been authorized yet." |
| "The BCB has no deadline to decide." | "The BCB has up to 1,080 days for incumbents (Res. 548/2026)." |
| "Res. 519, 520 and 521 all took effect Feb 2." | "Feb 2, except Res. 521's purpose-code and reporting parts, which started May 4." |
| "The cap is US$100k a day / in total." / "Just split the invoice." | "US$100k per payment for a non-bank VASP. We never split invoices." |
| "The Mexican off-ramp is licensed." / "a licensed non-bank" | "A SAT-registered virtual-asset platform." |
| "Mexico reaffirmed the ban in 2026." | "Circular 4/2019 is still in force. Its only amendment was in 2020." |
| "The FX warning is a regulation." / "official vs. blue" | "A business-risk flag: USDT/ARS vs. the BCRA **wholesale** rate." |
| "These rules are legally verified." | "Verified against primary sources on Oct 17 and pending human compliance review. Not legal advice." |
