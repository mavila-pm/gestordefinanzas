-- An expected income whose pay day is not known yet ("no sé") is still a declared income: it is stored with its
-- amount and day_of_month NULL ("día por confirmar"). The planner never projects it until the day is set
-- (incomeOccurrencesBetween stops on a null day), so nothing is invented. Weekly/biweekly keep their anchor rule.
alter table public.expected_incomes drop constraint expected_incomes_check2;
alter table public.expected_incomes add constraint expected_incomes_schedule check (
  case frequency
    when 'monthly' then true
    when 'semimonthly' then (day_of_month is null and second_day is null)
                         or (day_of_month is not null and second_day is not null and second_day <> day_of_month)
    else anchor_date is not null
  end);
