const auditHelpers = require("../../helpers/auditHelpers");
const jiraHelpers = require("../../helpers/jira2Helpers");
const subTaskAudits = require("../issueTypeAudits/subTaskAudits.js");
const commonAudits = require("../issueTypeAudits/commonAudits.js");
const AuditDetails = require("../AuditDetails");

const DEFAULT_SUBTASK_FIELDS = require('../../const/jira2Fields.js').DEFAULT_SUBTASK_FIELDS;
const JIRA2_FIELDS = require('../../const/jira2Fields.js').JIRA_FIELDS;
const IGNORE_AUDIT_LABELS = auditHelpers.IGNORE_AUDIT_LABELS;

const templateLink = "https://jira2.cerner.com/browse/MPAGESCORE-30188";

/**
 * This function runs all the required audits relating to the Hazard Analysis sub-task for an issue.
 * @param issue The issue on which to perform the Hazard Analysis audits
 * @returns {Promise<AuditDetails>} An AuditDetails object which contains the audit information for the issue.
 */
function runHazardAnalysisAudits(issue){
    return new Promise(async (resolve, reject) => {
        let auditDetail;
        let auditingSubTaskLink = false;
        let originalHazardSubTask;
        const allAuditResults = [];

        // Get the Hazard Analysis sub task
        let defineHazardAnalysis = jiraHelpers.getSubTaskByName(issue, auditHelpers.SUBTASK_NAMES.HAZARD_ANALYSIS);

        // Create the Hazard Analysis sub task audit details object to populate.  If there is a Hazard Analysis sub task, that link will be used.
        // Else, the parent issue will be populated
        const hazardAnalysisAuditDetails = new AuditDetails("Hazard Analysis Sub-Task Audit", defineHazardAnalysis || issue);

        // Any issue which was closed prior to April 22nd, 2019 will not be audited.  This was the beginning date for the enforcement of Hazards Analysis auditing, thus all issues resolved prior are grandfathered in.  IE audit will auto pass
        const resolutionDate = new Date(issue.fields[JIRA2_FIELDS.RESOLUTION_DATE]);
        if (resolutionDate < new Date("2019-04-22")) {
            hazardAnalysisAuditDetails.auditPassing = true;             
            hazardAnalysisAuditDetails.auditDetails = `This audit is being ignored since the issue was resolved prior to the audit introduction date of April 22nd, 2019`;

            return resolve(hazardAnalysisAuditDetails);
        }

        // Check to see if we should ignore this audit entirely based on the override labels
        if (jiraHelpers.issueContainsAnyLabel(issue, [IGNORE_AUDIT_LABELS.HAZARD_ANALYSIS])){
            hazardAnalysisAuditDetails.auditDetails = "Audit ignored";
            // Cleanse all of the sub-task comments
            await cleanseSubTaskAudits(issue);
            return resolve(hazardAnalysisAuditDetails);
        }

        // Check to see if there is even a Hazard Analysis sub task before performing audits on it
        auditDetail = await issueHasHazardAnalysisSubTask(issue);
        hazardAnalysisAuditDetails.addAuditResults(auditDetail);
        if (!auditDetail.auditPassing) {
            return resolve(hazardAnalysisAuditDetails);
        }

        // Check to see if the sub-task has been closed as no work necessary and validate if so
        auditDetail = await isNoWorkNeededResolutionValid(issue, defineHazardAnalysis);
        if(auditDetail) {
            hazardAnalysisAuditDetails.addAuditResults(auditDetail);
            jiraHelpers.handlePassFailAuditResults(defineHazardAnalysis, hazardAnalysisAuditDetails);
            return resolve(hazardAnalysisAuditDetails);
        }

        // Check to see if there is an issueLink which links out to another "Hazard Analysis" sub-task
        const subTaskLinks = defineHazardAnalysis.fields.issuelinks.filter(issueLink => jiraHelpers.isSubtaskLinkOfType(issueLink, auditHelpers.SUBTASK_NAMES.HAZARD_ANALYSIS));
        if(subTaskLinks && subTaskLinks.length){
            auditDetail = await issueHasOneSubTaskLink(defineHazardAnalysis);
            hazardAnalysisAuditDetails.addAuditResults(auditDetail);
            if(!auditDetail.auditPassing){
                // Since there are more than two sub-tasks linked fail hard and fast
                await jiraHelpers.handlePassFailAuditResults(defineHazardAnalysis, hazardAnalysisAuditDetails);
                return resolve(hazardAnalysisAuditDetails);
            }

            // Set flag to indicate that audits are running on a linked sub-task
            auditingSubTaskLink = true;

            // Save off a reference to the original code review sub-task and reassign defineHazardAnalysis to the linked sub-task
            originalHazardSubTask = defineHazardAnalysis;
            defineHazardAnalysis = await jiraHelpers.getIssueFromLink(subTaskLinks[0], DEFAULT_SUBTASK_FIELDS);

            // Perform audits on the current sub-task before we perform them on the linked sub task
            hazardAnalysisAuditDetails.addAuditResults(await subTaskAudits.subTaskClosed(originalHazardSubTask));
            hazardAnalysisAuditDetails.addAuditResults(await commonAudits.isAssigneeIndicated(originalHazardSubTask));
        }
        else{
            allAuditResults.push(await subTaskAudits.subTaskClosed(defineHazardAnalysis));
        }

        // Perform the core audits for this sub-task
        allAuditResults.push(await commonAudits.isAssigneeIndicated(defineHazardAnalysis));
        auditDetail = await hazardAnalysisComplete(defineHazardAnalysis);
        allAuditResults.push(auditDetail);
        if(auditDetail.auditPassing){
            allAuditResults.push(await hazardAnalysisReviewed(defineHazardAnalysis));
        }

        // If we are auditing a linked sub-task we need to combine the audit details into one audit
        if(auditingSubTaskLink){
            let auditComment = "\n\n";

            // Combine all the subTask audits into one comment body
            allAuditResults.forEach( audit => {
                if(!audit.auditPassing){
                    auditComment += jiraHelpers.generateAuditCommentText(audit) + "\n\n";
                }
            });

            // loop through the allAuditRseults and see if any failed.  If so post them to the original sub-task
            auditDetail = new AuditDetails("Linked Hazard Analysis Sub-Task Audit", originalHazardSubTask);
            if(!allAuditResults.every( audit => audit.auditPassing)){
                auditDetail.auditDetails = `The audit details below are currently failing for the linked sub-task and transitively causing this sub-task audit failure:\n\n{quote}${auditComment}{quote}`;
                auditDetail.auditPassing = false;

                // post the details out to the sub-task
                await jiraHelpers.postIssueAuditFailureComment(originalHazardSubTask, auditDetail, true);
            }
            else{
                auditDetail.auditDetails = `All audits for the linked Hazard Analysis sub-task have passed successfully:\\n\\n{quote}${auditComment}{quote}`;
                auditDetail.auditPassing = true;

                // Remove the audit failure comment from the story
                await jiraHelpers.removeIssueAuditFailureComment(originalHazardSubTask, auditDetail);
            }

            // Save this as the audit since it was a linked sub-task
            hazardAnalysisAuditDetails.addAuditResults(auditDetail);

            // Reassign to the original sub-task
            defineHazardAnalysis = originalHazardSubTask;
        }
        else{
            // Remove any Linked Issue audit failure messages since an issue is no longer linked
            await jiraHelpers.removeIssueAuditFailureCommentByName(defineHazardAnalysis, "Linked Hazard Analysis Sub-Task Audit");
            // Add the audit details to the auditDetails object for this issue
            hazardAnalysisAuditDetails.addAuditResults(allAuditResults);
        }

        await jiraHelpers.handlePassFailAuditResults(defineHazardAnalysis, hazardAnalysisAuditDetails);
        return resolve(hazardAnalysisAuditDetails);
    });
}

/**
 * This function evaluates if there is a Hazard Analysis sub-task for this issue
 * @param issue The issue to audit for the Hazard Analysis sub-task
 * @returns {Promise<AuditDetails>} An AuditDetails object which contains the audit information for the issue.
 */
function issueHasHazardAnalysisSubTask(issue){
    return new Promise(async (resolve, reject) => {
        const issueHasHazardAnalysisTask = new AuditDetails("Issue Requires A Hazard Analysis Sub-Task", issue);

        // Get the Hazard Analysis sub task
        const hazardAnalysisTask = jiraHelpers.getSubTaskByName(issue, auditHelpers.SUBTASK_NAMES.HAZARD_ANALYSIS);

        // Check to see if a Hazard Analysis sub task exists and fail if not
        if(!hazardAnalysisTask){
            // Fail the audit for not having a Hazard Analysis sub task
            issueHasHazardAnalysisTask.auditDetails = `A Hazard Analysis sub-task is required for all stories; please clone Jira stories from the [Story and Defect template|${templateLink}].`;
            issueHasHazardAnalysisTask.auditPassing = false;

            // Post the audit results to the parent issue
            await jiraHelpers.postIssueAuditFailureComment(issue, issueHasHazardAnalysisTask);
        }
        else{
            // Pass the audit for having a Hazard Analysis sub task
            issueHasHazardAnalysisTask.auditDetails = "Hazard Analysis sub-task is required and present";
            issueHasHazardAnalysisTask.auditPassing = true;

            // Remove the audit failure comment from the story
            await jiraHelpers.removeIssueAuditFailureComment(issue, issueHasHazardAnalysisTask);
        }

        return resolve(issueHasHazardAnalysisTask);
    })
}

/**
 * This functions check to see if a 'No Work Needed' resolution is applied to the sub-task and then checks to see
 * if that resolution is valid.
 * @param parentIssue The parent issue for the sub-task.  Will be used to see if the parent issue has been closed
 *  with a 'No Work Needed' resolution.
 * @param subTask The sub-task to audit for a 'No Work Needed' resolution.
 * @returns {Promise<any>} The AuditDetails results for this audit
 */
function isNoWorkNeededResolutionValid(parentIssue, subTask){
    return new Promise( async (resolve, reject) => {
        const noWorkNeededValid = new AuditDetails("Hazard Analysis No Work Needed Resolution Validation", subTask);

        // Check to ensure the issue has been closed with a no work needed resolution
        if(!jiraHelpers.issueHasNoWorkNeededResolution(subTask)){
            await jiraHelpers.removeIssueAuditFailureComment(subTask, noWorkNeededValid);
            return resolve(null);
        }

        // Check the parent issue status and if it is marked as no work being done then accept the status
        if(jiraHelpers.issueHasNoWorkNeededResolution(parentIssue)){
            // Pass the audit since the parent issue is in a valid status for this sub-task to be in a no work needed resolution
            noWorkNeededValid.auditDetails = `Hazard analysis resolution of ${subTask.fields.resolution.name} is valid since the parent issue was closed with a ${parentIssue.fields.resolution.name} resolution.`;
            noWorkNeededValid.auditPassing = true;

            // Remove the audit failure comment from the story
            await jiraHelpers.removeIssueAuditFailureComment(subTask, noWorkNeededValid);
        }
        else{
            // Fail the audit since this hazard analysis is required for all stories
            noWorkNeededValid.auditDetails = "Hazard analysis is required for all stories.  It is not valid to close this sub-task as not needing any work.  If the " +
                "hazard analysis has been created under another Hazard Analysis sub-task, please link directly to that sub-task via a _JIRA Issue_ link so it can be audited.";
            noWorkNeededValid.auditPassing = false;

            // Post the audit results to the parent issue
            await jiraHelpers.postIssueAuditFailureComment(subTask, noWorkNeededValid);
        }

        return resolve(noWorkNeededValid);
    })
}

/**
 * This function checks the description of the Hazard Analysis to ensure the form has been answered
 * @param issue The issue to be audited for completion of the Hazard Analysis
 * @returns {Promise<AuditDetails>} An AuditDetails object which contains the audit information for the issue.
 */
function hazardAnalysisComplete(issue){
    return new Promise(async (resolve, reject) => {
        const hazardAnalysisComplete = new AuditDetails("Hazard Analysis Completed", issue);
        const descriptionBody = issue.fields.description;

        // These are the Regular Expressions used to check each line for the questions in the Hazard Analysis description field 
        const financialRegex = new RegExp(/Financial\:\*?(.+?[>]?)\W*Legal\/Regulatory/gims);
        const legalRegex = new RegExp(/Legal\/Regulatory\:\*?(.+?[>]?)\W*Data Integrity/gims);
        const dataRegex = new RegExp(/Data Integrity\:\*?(.+?[>]?)\W*Patient Safety/gmis);
        const patientRegex = new RegExp(/Patient Safety\:\*?(.+?[>]?)\W*CyberSecurity\/Information Security/gmis);
        const cyberSecurityRegex = new RegExp(/CyberSecurity\/Information Security\:(.+)/gims);
        const yesNoRegex = new RegExp(/\s*\<yes or no\. if yes, explain why\>|\<yes\/no\>\s*/gims);
        const fillCheckRegex = new RegExp(/(\S+)/im);

        // Regular Expression magic first finds the description body lines needed for each Hazard Analysis question and turns it into a string
        // then removes expected templates by line to see what answer, if any, is left over. Fails fast if question is not answered.
        // Each block of following code and if statement checks a different field that needs answered

        // First assign tempStr to find answer to financial question in the description body. The answer will be in an array.
        let tempStr = descriptionBody.match(financialRegex);
        // If there is nothing returned then it is not the right template or something was altered to the point it was not caught.
        if (tempStr === null) {
            // If null leads to the correct template to use for the Hazard Analysis
            hazardAnalysisComplete.auditDetails = `Financial description does not match expected description for Hazard Analysis. You can copy the description directly from the Perform Hazard Analysis 
            sub-task found in the Story and Defect template; please clone Jira stories from the [Story and Defect template|${templateLink}]`;
            hazardAnalysisComplete.auditPassing = false;
            return resolve(hazardAnalysisComplete);
        }
        else{       
            // Here the description body is changed into a string from the initial array form. Next the matched regular expression for the question we are looking  
            // for is stripped downto the answer portion or $1 which is group one of the regular expression (the yes/no template and the answer part) of the regexp is left. 
            // Next the regular expression for the yes/no template is used to strip away that part and only the answer that was typed in should be left. 
            tempStr = tempStr.toString().replace(financialRegex, '$1').replace(yesNoRegex, "");
            // This uses the fillCheckRegex to check for any answer that should be left. If not answered then stops the audit here and fails.
            if (!fillCheckRegex.test(tempStr)){
                // Hazard analysis has not been completed.
                hazardAnalysisComplete.auditDetails = "The financial question of the Hazard analysis must be answered.";
                hazardAnalysisComplete.auditPassing = false;
                // Post the audit results to the sub-task since it failed
                await jiraHelpers.postIssueAuditFailureComment(issue, hazardAnalysisComplete, true);
                return resolve(hazardAnalysisComplete);
            }
        }       
        // Reassign tempStr to find answer to legal/regulatory question in the description body. The answer will be in an array.
        tempStr = descriptionBody.match(legalRegex);
        // If there is nothing returned then it is not the right template or something was altered to the point it was not caught.
        if (tempStr === null) {
            // If null leads to the correct template to use for the Hazard Analysis
            hazardAnalysisComplete.auditDetails = `Legal/Regulatory description does not match expected description for Hazard Analysis. You can copy the description directly from the Perform Hazard Analysis 
            sub-task found in the Story and Defect template; please clone Jira stories from the [Story and Defect template|${templateLink}]`;
            hazardAnalysisComplete.auditPassing = false;
            return resolve(hazardAnalysisComplete);
        }
        else{    
            // Here the description body is changed into a string from the initial array form. Next the matched regular expression for the question we are looking  
            // for is stripped downto the answer portion or $1 which is group one of the regular expression (the yes/no template and the answer part) of the regexp is left. 
            // Next the regular expression for the yes/no template is used to strip away that part and only the answer that was typed in should be left.
            tempStr = tempStr.toString().replace(legalRegex, '$1').replace(yesNoRegex, "");
            // This uses the fillCheckRegex to check for any answer that should be left. If not answered then stops the audit here and fails.
            if (!fillCheckRegex.test(tempStr)){
                // Hazard analysis has not been completed.
                hazardAnalysisComplete.auditDetails = "The legal/regulatory question of the Hazard analysis must be answered.";
                hazardAnalysisComplete.auditPassing = false;
                // Post the audit results to the sub-task since it failed
                await jiraHelpers.postIssueAuditFailureComment(issue, hazardAnalysisComplete, true);
                return resolve(hazardAnalysisComplete);
            }
        }
        // Reassign tempStr to find answer to data integrity question in the description body. The answer will be in an array.
        tempStr = descriptionBody.match(dataRegex);
        // If there is nothing returned then it is not the right template or something was altered to the point it was not caught.
        if (tempStr === null) {
            // If null leads to the correct template to use for the Hazard Analysis
            hazardAnalysisComplete.auditDetails = `Data Integrity description does not match expected description for Hazard Analysis. You can copy the description directly from the Perform Hazard Analysis 
            sub-task found in the Story and Defect template; please clone Jira stories from the [Story and Defect template|${templateLink}]`;
            hazardAnalysisComplete.auditPassing = false;
            return resolve(hazardAnalysisComplete);
        }
        else{
            // Here the description body is changed into a string from the initial array form. Next the matched regular expression for the question we are looking  
            // for is stripped downto the answer portion or $1 which is group one of the regular expression (the yes/no template and the answer part) of the regexp is left. 
            // Next the regular expression for the yes/no template is used to strip away that part and only the answer that was typed in should be left.
            tempStr = tempStr.toString().replace(dataRegex, '$1').replace(yesNoRegex, "");
            // This uses the fillCheckRegex to check for any answer that should be left. If not answered then stops the audit here and fails.
            if (!fillCheckRegex.test(tempStr)){
                // Hazard analysis has not been completed.
                hazardAnalysisComplete.auditDetails = "The data integrity question of the Hazard analysis must be answered.";
                hazardAnalysisComplete.auditPassing = false;
                // Post the audit results to the sub-task since it failed
                await jiraHelpers.postIssueAuditFailureComment(issue, hazardAnalysisComplete, true);
                return resolve(hazardAnalysisComplete);
            }
        }
        // Reassign tempStr to find answer to patient safety question in the description body. The answer will be in an array.
        tempStr = descriptionBody.match(patientRegex);
        // If there is nothing returned then it is not the right template or something was altered to the point it was not caught.
        if (tempStr === null) {
            // If null leads to the correct template to use for the Hazard Analysis
            hazardAnalysisComplete.auditDetails = `Patient Safety description does not match expected description for Hazard Analysis. You can copy the description directly from the Perform Hazard Analysis 
            sub-task found in the Story and Defect template; please clone Jira stories from the [Story and Defect template|${templateLink}]`;
            hazardAnalysisComplete.auditPassing = false;
            return resolve(hazardAnalysisComplete);
        }
        else{
            // Here the description body is changed into a string from the initial array form. Next the matched regular expression for the question we are looking  
            // for is stripped downto the answer portion or $1 which is group one of the regular expression (the yes/no template and the answer part) of the regexp is left. 
            // Next the regular expression for the yes/no template is used to strip away that part and only the answer that was typed in should be left.
            tempStr = tempStr.toString().replace(patientRegex, '$1').replace(yesNoRegex, "");
            // This uses the fillCheckRegex to check for any answer that should be left. If not answered then stops the audit here and fails.
            if (!fillCheckRegex.test(tempStr)){
                // Hazard analysis has not been completed.
                hazardAnalysisComplete.auditDetails = "The patient safety question of the Hazard analysis must be answered.";
                hazardAnalysisComplete.auditPassing = false;
                // Post the audit results to the sub-task since it failed
                await jiraHelpers.postIssueAuditFailureComment(issue, hazardAnalysisComplete, true);
                return resolve(hazardAnalysisComplete);
            }
        }
        // Reassign tempStr to find answer to cybersecurity/information security question in the description body. The answer will be in an array.
        tempStr = descriptionBody.match(cyberSecurityRegex);
        // If there is nothing returned then it is not the right template or something was altered to the point it was not caught.
        if (tempStr === null) {
            // If null leads to the correct template to use for the Hazard Analysis
            hazardAnalysisComplete.auditDetails = `CyberSecurity/Information description does not match expected description for Hazard Analysis. You can copy the description directly from the Perform Hazard Analysis 
            sub-task found in the Story and Defect template; please clone Jira stories from the [Story and Defect template|${templateLink}]`;
            hazardAnalysisComplete.auditPassing = false;
            return resolve(hazardAnalysisComplete);
        }
        else{
            // Here the description body is changed into a string from the initial array form. Next the matched regular expression for the question we are looking  
            // for is stripped downto the answer portion or $1 which is group one of the regular expression (the yes/no template and the answer part) of the regexp is left. 
            // Next the regular expression for the yes/no template is used to strip away that part and only the answer that was typed in should be left.
            // Since this was the last question on the form it captures to the end of the description body and an added step here is to strip away the last part of 
            // the template if it is there before stripping away the yes/no template part.
            tempStr = tempStr.toString().replace(cyberSecurityRegex, '$1').replace(new RegExp (/\**\s*Engineer.+/gims), "").replace(yesNoRegex, "");
            // This uses the fillCheckRegex to check for any answer that should be left. If not answered then stops the audit here and fails.
            if (!fillCheckRegex.test(tempStr)){
                // Hazard analysis has not been completed.
                hazardAnalysisComplete.auditDetails = "The cybersecurity/information question of the Hazard analysis must be answered.";
                hazardAnalysisComplete.auditPassing = false;
                // Post the audit results to the sub-task since it failed
                await jiraHelpers.postIssueAuditFailureComment(issue, hazardAnalysisComplete, true);
                return resolve(hazardAnalysisComplete);
            }
        }

        hazardAnalysisComplete.auditDetails = "Hazard analysis has been completed for this sub-task.";
        hazardAnalysisComplete.auditPassing = true;

        // Remove the audit failure comment from the story
        await jiraHelpers.removeIssueAuditFailureComment(issue, hazardAnalysisComplete);

        return resolve(hazardAnalysisComplete);
    });
}

/**
 * This function checks for the hazard analysis to receive a '+1' from a reviewer other than the author
 * @param issue This issue to be audited to ensure the Hazard Analysis has been reviewed
 * @returns {Promise<AuditDetails>} An AuditDetails object which contains the audit information for the issue.
 */
function hazardAnalysisReviewed(issue){
    return new Promise(async (resolve, reject) => {
        const hazardAnalysisReviewed = new AuditDetails("Hazard Analysis Reviewed", issue);
        const plusOneComments = jiraHelpers.findPlusOneComments(issue);

        if(!plusOneComments.length){
            hazardAnalysisReviewed.auditDetails = "Hazard Analysis must receive a '+1' comment from a reviewer other than the author before the sub-task can be closed.";
            hazardAnalysisReviewed.auditPassing = false;

            // Post the audit results to the sub-task since it failed
            await jiraHelpers.postIssueAuditFailureComment(issue, hazardAnalysisReviewed);
        }
        else{
            hazardAnalysisReviewed.auditDetails = "Hazard Analysis has received a '+1' comment from a reviewer other than the author.";
            hazardAnalysisReviewed.auditPassing = true;

            // Remove the audit failure comment from the story
            await jiraHelpers.removeIssueAuditFailureComment(issue, hazardAnalysisReviewed);
        }

        return resolve(hazardAnalysisReviewed);
    });
}

/**
 * This function will cleanse the parent issue and sub-task of all auditor comments and labels which have
 * been added by this sub-task auditor
 * @param issue The parent issue where the sub-task resides
 * @returns {Promise<AuditDetails>} An AuditDetails object which contains the audit information for the issue.
 */
async function cleanseSubTaskAudits(issue){
    const cleanseSubTask = new AuditDetails("Hazard Analysis Sub-Task Cleanse", issue);
    cleanseSubTask.auditDetails = "All audit comments and labels will be removed from this sub-task";

    // Get the Hazard Analysis sub task
    let subTask = jiraHelpers.getSubTaskByName(issue, auditHelpers.SUBTASK_NAMES.HAZARD_ANALYSIS);
    if(subTask){
        await jiraHelpers.handlePassFailAuditResults(subTask, cleanseSubTask);
    }
    else{
        await jiraHelpers.removeIssueAuditFailureCommentByName(issue, "Issue Requires A Hazard Analysis Sub-Task");
    }

    return cleanseSubTask;
}

module.exports = {
    runHazardAnalysisAudits,
    issueHasHazardAnalysisSubTask,
    isNoWorkNeededResolutionValid,
    hazardAnalysisComplete,
    hazardAnalysisReviewed,
    cleanseSubTaskAudits
};
