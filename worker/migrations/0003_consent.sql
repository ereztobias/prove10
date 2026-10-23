-- What someone agreed to, kept verbatim and per row.
--
-- GDPR Article 7(1) puts the burden of showing consent on us, and a
-- timestamp alone does not show what was consented to. The wording on
-- the page will change one day; these rows must keep the wording that
-- was actually on screen when each person submitted.
alter table signups add column consent text;
