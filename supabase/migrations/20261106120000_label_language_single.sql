-- BC-LANG-1: the language setting is now English OR Español, one at a time.
--
-- The old "English + Español" value (`en_es`) showed every label twice. The
-- people who chose it — and the crew roles it was the default for — wanted
-- the Spanish visible, so they become Español. "English only" (`en`) stays
-- English. The app also reads a leftover `en_es` as Español
-- (`parseLabelLanguage` in src/lib/label-language.ts), so this is tidy-up,
-- not a precondition: nothing breaks before or after it runs.

update public.user_view_prefs
   set view_mode = 'es',
       updated_at = now()
 where scope = 'field_label_language'
   and view_mode = 'en_es';
